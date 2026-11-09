// Builds country databases one at a time, in child processes so the map stays
// responsive. The build writes to a staging folder. Only a result that passes
// validation replaces the live database, and the old one is kept beside it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS = new Set(["queued", "running"]);

export function createBuildManager({
  repoRoot,
  inputDir,
  analyticsDir,
  activity,
  spawnImpl = spawn,
  now = Date.now,
}) {
  const python = path.join(repoRoot, ".venv/bin/python");
  const pipeline = (name) => path.join(repoRoot, "code/pipeline", name);
  const stagingRoot = path.join(analyticsDir, ".staging");
  const autoBoundaries = path.join(inputDir, "boundaries/auto");
  const jobs = new Map();
  const queue = [];
  let active = null;
  let running = Promise.resolve();

  const log = (job, text, level) => activity.add(job.name, text, level);

  function removeAbandonedStaging() {
    if (!existsSync(stagingRoot)) return;
    for (const name of readdirSync(stagingRoot)) {
      const folder = path.join(stagingRoot, name);
      // A recent folder may belong to another server running in this folder.
      if (Date.now() - statSync(folder).mtimeMs > STALE_STAGING_MS)
        rmSync(folder, { recursive: true, force: true });
    }
  }
  removeAbandonedStaging();

  function runScript(job, script, args) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(python, [pipeline(script), ...args], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAYFINDER_NODE: process.execPath },
      });
      job.child = child;
      let lastError = "";
      readline
        .createInterface({ input: child.stdout })
        .on("line", (line) => line.trim() && log(job, line.trim()));
      readline.createInterface({ input: child.stderr }).on("line", (line) => {
        if (line.trim()) lastError = line.trim();
      });
      child.on("error", () => reject(new Error("The build tools couldn't start.")));
      child.on("close", (code) => {
        job.child = null;
        if (code === 0) resolve();
        else reject(new Error(lastError || "The build stopped unexpectedly."));
      });
    });
  }

  function enterStage(job, stage, message) {
    job.stage = stage;
    log(job, message);
  }

  async function run(job) {
    const staging = path.join(stagingRoot, job.code + "-" + randomUUID());
    const output = path.join(staging, job.code + ".sqlite");
    const live = path.join(analyticsDir, job.code + ".sqlite");
    job.state = "running";
    job.startedMs = now();
    job.error = null;
    try {
      await mkdir(staging, { recursive: true });
      let countryArgs = ["--country", job.code];
      // A country with hand-checked settings, like Luxembourg, keeps them.
      if (!existsSync(pipeline("countries/" + job.code + ".json"))) {
        enterStage(job, "regions", "Finding regions in the downloaded data");
        await runScript(job, "extract-regions.py", [
          "--code", job.code,
          "--name", job.name,
          "--pbf", job.pbf,
          "--source", job.source,
          "--output-dir", autoBoundaries,
        ]);
        countryArgs = [
          "--country", path.join(autoBoundaries, job.code + ".json"),
          "--boundaries", path.join(autoBoundaries, job.code + ".geojson"),
        ];
      }
      enterStage(job, "building", "Building the database");
      await runScript(job, "prepare-analytics.py", [
        ...countryArgs,
        "--pbf", job.pbf,
        "--output", output,
      ]);
      enterStage(job, "checking", "Checking the new database");
      await runScript(job, "validate-analytics.py", [
        "--candidate", output,
        "--country", job.code,
        ...(existsSync(live) ? ["--previous", live] : []),
      ]);
      job.stage = "publishing";
      if (existsSync(live))
        await copyFile(
          live,
          path.join(analyticsDir, job.code + ".previous.sqlite"),
          constants.COPYFILE_FICLONE,
        );
      // Tiles first: a page that sees the new database expects its tiles.
      if (existsSync(output.replace(/\.sqlite$/, ".pmtiles")))
        await rename(
          output.replace(/\.sqlite$/, ".pmtiles"),
          live.replace(/\.sqlite$/, ".pmtiles"),
        );
      await rename(output, live);
      job.state = "done";
      log(job, "Built and now available in the app", "success");
    } catch (error) {
      if (job.stopRequested) {
        job.state = "cancelled";
        log(job, "Build stopped. The app's data was not changed.", "warning");
      } else {
        job.state = "failed";
        job.error = error.message;
        log(job, "Build failed: " + error.message, "error");
        console.error("Build failed for " + job.code + ":", error.message);
      }
    } finally {
      job.child = null;
      job.stopRequested = false;
      job.finishedMs = now();
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    running = run(job).finally(() => {
      active = null;
      pump();
    });
  }

  function view(job) {
    const { code, name, state, stage, error, expectedSeconds } = job;
    return {
      code,
      name,
      state,
      stage,
      error,
      expectedSeconds,
      elapsedSeconds: job.startedMs
        ? Math.round(((job.finishedMs ?? now()) - job.startedMs) / 1000)
        : 0,
    };
  }

  return {
    start({ code, name, pbf, source, expectedSeconds }) {
      const existing = jobs.get(code);
      if (existing && IN_PROGRESS.has(existing.state)) return existing;
      const job = {
        code,
        name,
        pbf,
        source,
        expectedSeconds: expectedSeconds ?? null,
        state: "queued",
        stage: null,
        error: null,
      };
      jobs.set(code, job);
      queue.push(job);
      if (active) log(job, "Waiting for the current build to finish");
      pump();
      return job;
    },
    stop(code) {
      const job = jobs.get(code);
      if (job?.state === "queued") {
        queue.splice(queue.indexOf(job), 1);
        job.state = "cancelled";
        log(job, "Stopped", "warning");
        return true;
      }
      if (job?.state !== "running" || !job.child) return false;
      job.stopRequested = true;
      job.child.kill("SIGTERM");
      return true;
    },
    stopAll() {
      active?.child?.kill("SIGTERM");
    },
    view(code) {
      const job = jobs.get(code);
      return job ? view(job) : null;
    },
    jobs: () =>
      [...jobs.values()].filter((job) => IN_PROGRESS.has(job.state)).map(view),
    isBusy: () => Boolean(active) || queue.length > 0,
    whenIdle: async () => {
      while (active || queue.length) await running;
    },
  };
}
