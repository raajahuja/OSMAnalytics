import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createBuildManager, missingTools } from "../../server/builds.mjs";
import { createActivityLog } from "../../server/downloads.mjs";

function setup(behaviour = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-builds-"));
  const repoRoot = path.join(root, "repo");
  const inputDir = path.join(root, "input");
  const analyticsDir = path.join(root, "analytics");
  fs.mkdirSync(path.join(repoRoot, "code/pipeline/countries"), { recursive: true });
  fs.mkdirSync(analyticsDir);
  const activity = createActivityLog();
  const calls = [];
  const children = [];

  // Stands in for the Python scripts. Each one succeeds unless told otherwise.
  function spawnImpl(_python, [script, ...args]) {
    const name = path.basename(script);
    calls.push({ name, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null);
    };
    children.push(child);
    if (behaviour[name] === "hang") return child;
    setImmediate(() => {
      if (name === "prepare-analytics.py")
        fs.writeFileSync(args[args.indexOf("--output") + 1], "new database");
      child.stdout.write(name + " ran\n");
      if (behaviour[name]) child.stderr.write("noise\n" + behaviour[name] + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", behaviour[name] ? 1 : 0));
    });
    return child;
  }

  const builds = createBuildManager({
    repoRoot,
    inputDir,
    analyticsDir,
    activity,
    spawnImpl,
    ...options,
  });
  const live = path.join(analyticsDir, "JO.sqlite");
  const stagingFolders = () => {
    const folder = path.join(analyticsDir, ".staging");
    return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  };
  return { builds, calls, children, live, activity, repoRoot, inputDir, analyticsDir, stagingFolders };
}

const jordan = {
  code: "JO",
  name: "Jordan",
  pbf: "/data/jordan.osm.pbf",
  source: "https://download.geofabrik.de/asia/jordan.html",
};
const messages = (activity) => activity.entries().map((entry) => entry.text);

test("a new country finds regions, builds, checks and goes live", async () => {
  const { builds, calls, live, stagingFolders } = setup();
  builds.start(jordan);
  await builds.whenIdle();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["extract-regions.py", "prepare-analytics.py", "validate-analytics.py"],
  );
  const prepare = calls[1].args;
  assert.ok(prepare[prepare.indexOf("--country") + 1].endsWith("auto/JO.json"));
  assert.ok(prepare.includes("--boundaries"));
  assert.equal(prepare[prepare.indexOf("--pbf") + 1], jordan.pbf);
  assert.equal(calls[2].args.includes("--previous"), false);
  assert.equal(fs.readFileSync(live, "utf8"), "new database");
  assert.equal(builds.view("JO").state, "done");
  assert.deepEqual(stagingFolders(), []);
});

test("a country with hand-checked settings keeps them", async () => {
  const { builds, calls, repoRoot } = setup();
  fs.writeFileSync(path.join(repoRoot, "code/pipeline/countries/JO.json"), "{}");
  builds.start(jordan);
  await builds.whenIdle();
  assert.deepEqual(
    calls.map((call) => call.name),
    ["prepare-analytics.py", "validate-analytics.py"],
  );
  const prepare = calls[0].args;
  assert.equal(prepare[prepare.indexOf("--country") + 1], "JO");
  assert.equal(prepare.includes("--boundaries"), false);
});

test("a rebuild keeps the old database as the previous copy", async () => {
  const { builds, calls, live, analyticsDir } = setup();
  fs.writeFileSync(live, "old database");
  builds.start(jordan);
  await builds.whenIdle();
  assert.ok(calls.at(-1).args.includes("--previous"));
  assert.equal(fs.readFileSync(live, "utf8"), "new database");
  assert.equal(
    fs.readFileSync(path.join(analyticsDir, "JO.previous.sqlite"), "utf8"),
    "old database",
  );
});

for (const script of [
  "extract-regions.py",
  "prepare-analytics.py",
  "validate-analytics.py",
]) {
  test(script + " failing leaves the live database untouched", async () => {
    const { builds, live, activity, stagingFolders } = setup({
      [script]: "Something specific went wrong",
    });
    fs.writeFileSync(live, "old database");
    builds.start(jordan);
    await builds.whenIdle();
    assert.equal(fs.readFileSync(live, "utf8"), "old database");
    const view = builds.view("JO");
    assert.equal(view.state, "failed");
    assert.equal(view.error, "Something specific went wrong");
    assert.ok(messages(activity).includes("Build failed: Something specific went wrong"));
    assert.deepEqual(stagingFolders(), []);
  });
}

test("stopping kills the build and leaves the live database untouched", async () => {
  const { builds, children, live, stagingFolders } = setup({
    "prepare-analytics.py": "hang",
  });
  fs.writeFileSync(live, "old database");
  builds.start(jordan);
  while (children.length < 2 || !builds.view("JO").stage?.includes("building"))
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(builds.jobs().length, 1);
  assert.equal(builds.stop("JO"), true);
  await builds.whenIdle();
  assert.equal(children.at(-1).killed, true);
  assert.equal(builds.view("JO").state, "cancelled");
  assert.equal(fs.readFileSync(live, "utf8"), "old database");
  assert.deepEqual(stagingFolders(), []);
});

test("builds run one at a time and a waiting one can be stopped", async () => {
  const { builds, children } = setup({ "prepare-analytics.py": "hang" });
  builds.start(jordan);
  builds.start({ ...jordan, code: "MT", name: "Malta" });
  assert.equal(builds.view("MT").state, "queued");
  assert.equal(builds.stop("MT"), true);
  assert.equal(builds.view("MT").state, "cancelled");
  while (children.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 2));
  builds.stop("JO");
  await builds.whenIdle();
  assert.equal(builds.isBusy(), false);
});

test("starting a build twice does not run it twice", async () => {
  const { builds, calls } = setup();
  builds.start(jordan);
  builds.start(jordan);
  await builds.whenIdle();
  assert.equal(calls.filter((c) => c.name === "prepare-analytics.py").length, 1);
});

test("a fresh checkout's first build names the missing tool", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-tools-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const env = { PATH: bin };
  assert.match(missingTools(root, env), /npm run setup/);
  fs.mkdirSync(path.join(root, ".venv/bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".venv/bin/python"), "");
  assert.match(missingTools(root, env), /tippecanoe isn't installed/);
  fs.writeFileSync(path.join(bin, "tippecanoe"), "");
  assert.equal(missingTools(root, env), null);
  assert.equal(
    missingTools(root, { PATH: "", WAYFINDER_TIPPECANOE: path.join(bin, "tippecanoe") }),
    null,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("hand-tuned regions missing from a fresh checkout are downloaded and checked", async () => {
  const body = '{"type":"FeatureCollection","features":[]}';
  const md5 = (await import("node:crypto")).createHash("md5").update(body).digest("hex");
  const requested = [];
  const { builds, calls, repoRoot, inputDir } = setup({}, {
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(body);
    },
  });
  fs.writeFileSync(
    path.join(repoRoot, "code/pipeline/countries/JO.json"),
    JSON.stringify({ boundaries: "boundaries/jo.geojson", boundaryUrl: "https://example.test/jo", boundaryMd5: md5 }),
  );
  builds.start(jordan);
  await builds.whenIdle();
  assert.deepEqual(requested, ["https://example.test/jo"]);
  const saved = path.join(inputDir, "boundaries/jo.geojson");
  assert.equal(fs.readFileSync(saved, "utf8"), body);
  assert.deepEqual(fs.readdirSync(path.dirname(saved)), ["jo.geojson"]);
  const prepare = calls.find((call) => call.name === "prepare-analytics.py").args;
  assert.equal(prepare[prepare.indexOf("--country") + 1], "JO");
  assert.equal(prepare[prepare.indexOf("--boundaries") + 1], saved);
  assert.ok(!calls.some((call) => call.name === "extract-regions.py"));
  assert.equal(builds.view("JO").state, "done");
});

test("a bad regions download falls back to automatic regions", async () => {
  const { builds, calls, repoRoot, inputDir, activity } = setup({}, {
    fetchImpl: async () => new Response("tampered"),
  });
  fs.writeFileSync(
    path.join(repoRoot, "code/pipeline/countries/JO.json"),
    JSON.stringify({ boundaries: "boundaries/jo.geojson", boundaryUrl: "https://example.test/jo", boundaryMd5: "0".repeat(32) }),
  );
  builds.start(jordan);
  await builds.whenIdle();
  assert.ok(!fs.existsSync(path.join(inputDir, "boundaries/jo.geojson")));
  assert.ok(calls.some((call) => call.name === "extract-regions.py"));
  assert.ok(messages(activity).some((text) => /checksum\), so regions are found automatically/.test(text)));
  assert.equal(builds.view("JO").state, "done");
});
