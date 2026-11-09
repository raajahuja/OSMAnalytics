import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { repoRoot } from "../helpers.mjs";

function resolved(env) {
  const script =
    'import("./code/server/paths.mjs").then((p)=>console.log(JSON.stringify(p)))';
  const clean = { ...process.env, ...env };
  if (!env.WAYFINDER_INPUT) delete clean.WAYFINDER_INPUT;
  if (!env.WAYFINDER_OUTPUT) delete clean.WAYFINDER_OUTPUT;
  const run = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    env: clean,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("data lives in input/ and output/ by default", () => {
  const paths = resolved({});
  assert.equal(paths.inputDir, path.join(repoRoot, "input"));
  assert.equal(paths.analyticsDir, path.join(repoRoot, "output/analytics"));
  assert.equal(paths.imageryDir, path.join(repoRoot, "output/cache/imagery"));
  assert.equal(paths.webRoot, path.join(repoRoot, "code/web"));
});

test("environment variables relocate data but not the web build", () => {
  const paths = resolved({
    WAYFINDER_INPUT: "/tmp/in",
    WAYFINDER_OUTPUT: "/tmp/out",
  });
  assert.equal(paths.inputDir, "/tmp/in");
  assert.equal(paths.analyticsDir, "/tmp/out/analytics");
  assert.equal(paths.webDist, path.join(repoRoot, "output/web"));
});
