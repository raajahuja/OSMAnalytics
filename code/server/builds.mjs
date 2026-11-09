// Builds country databases one at a time, in child processes so the map stays
// responsive. The build writes to a staging folder. Only a result that passes
// validation replaces the live database, and the old one is kept beside it.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Name what is missing, so a fresh checkout's first build says what to do.
export function missingTools(repoRoot, env = process.env) {
  if (!existsSync(path.join(repoRoot, ".venv/bin/python")))
    return "The Python tools aren't set up. Run npm run setup in the project folder, then build again.";
  const tippecanoe = env.WAYFINDER_TIPPECANOE || "tippecanoe";
  const found = tippecanoe.includes("/")
    ? existsSync(tippecanoe)
    : (env.PATH || "")
        .split(path.delimiter)
        .some((folder) => folder && existsSync(path.join(folder, tippecanoe)));
  if (!found)
    return "tippecanoe isn't installed. Install it (brew install tippecanoe, or see github.com/felt/tippecanoe), then build again.";
  return null;
}
import readline from "node:readline";

const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS = new Set(["queued", "running"]);

export function createBuildManager({
  repoRoot,
  inputDir,
  analyticsDir,
  activity,
  spawnImpl = spawn,
  fetchImpl = fetch,
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

  // A country with hand-checked settings, like Luxembourg, uses its own
  // regions. A fresh checkout doesn't have that file yet, so fetch it, and
  // fall back to automatic regions if that isn't possible.
  // Returns the extra build arguments, or null to find regions automatically.
  async function handTunedRegions(job) {
    const settingsFile = pipeline("countries/" + job.code + ".json");
    if (!existsSync(settingsFile)) return null;
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    const boundaries = path.join(inputDir, settings.boundaries || "");
    if (!settings.boundaries) return [];
    // Named explicitly, so WAYFINDER_INPUT applies to the Python side too.
    if (existsSync(boundaries)) return ["--boundaries", boundaries];
    const fallback = "so regions are found automatically";
    if (!settings.boundaryUrl) {
      log(job, "The regions file input/" + settings.boundaries + " is missing, " + fallback);
      return null;
    }
    enterStage(job, "regions", "Downloading the region boundaries");
    try {
      const response = await fetchImpl(settings.boundaryUrl, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("the server answered " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        settings.boundaryMd5 &&
        createHash("md5").update(bytes).digest("hex") !== settings.boundaryMd5
      )
        throw new Error("the file didn't match its checksum");
      await mkdir(path.dirname(boundaries), { recursive: true });
      const temporary = boundaries + "." + randomUUID() + ".part";
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, boundaries);
      } finally {
        await rm(temporary, { force: true });
      }
      log(job, "Saved the region boundaries as input/" + settings.boundaries);
      return ["--boundaries", boundaries];
    } catch (error) {
      log(job, "Couldn't download the region boundaries (" + error.message + "), " + fallback);
      return null;
    }
  }

  async function run(job) {
    const staging = path.join(stagingRoot, job.code + "-" + randomUUID());
    const output = path.join(staging, job.code + ".sqlite");
    const live = path.join(analyticsDir, job.code + ".sqlite");
    job.state = "running";
    job.startedMs = now();
    job.error = null;
    try {
      // Test doubles replace spawn and need no real tools.
      const missing = spawnImpl === spawn && missingTools(repoRoot);
      if (missing) throw new Error(missing);
      await mkdir(staging, { recursive: true });
      const handTuned = await handTunedRegions(job);
      let countryArgs = ["--country", job.code, ...(handTuned ?? [])];
      if (!handTuned) {
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
