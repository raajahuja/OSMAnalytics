// Quick "is it alive?" checks against the production server and fixture data.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildFixture,
  removeFixture,
  repoRoot,
  startServer,
} from "../helpers.mjs";

let output, app;
before(async () => {
  output = buildFixture();
  app = await startServer({ output });
});
after(async () => {
  await app?.stop();
  if (output) removeFixture(output);
});

test("the app shell, stylesheet and bundled scripts load", async () => {
  const html = await app.get("/");
  assert.equal(html.status, 200);
  assert.match(html.text, /OpenStreetMap Analytics/);
  const assets = [...html.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.some((asset) => asset.endsWith(".js")));
  for (const asset of assets)
    assert.equal((await app.get(asset)).status, 200, asset);
});

test("client-side routes fall back to the app shell", async () => {
  const page = await app.get("/analytics");
  assert.equal(page.status, 200);
  assert.match(page.text, /id="root"/);
});

test("every analytics endpoint answers", async () => {
  const bbox = "5.9,49.5,6.3,49.8";
  for (const pathname of [
    "/api/analytics",
    "/api/analytics/LU",
    "/api/analytics/LU/tags",
    "/api/analytics/LU/tags?key=highway",
    "/api/analytics/LU/map",
    `/api/analytics/LU/features?key=highway&bbox=${bbox}`,
    "/api/analytics/LU/selection?key=highway",
    "/api/analytics/LU/nearby?lat=49.53&lon=5.93&radius=500",
    "/api/analytics/LU/object/node/101",
  ])
    assert.equal((await app.get(pathname)).status, 200, pathname);
});

test("errors use the right status codes", async () => {
  assert.equal((await app.get("/api/nope")).status, 404);
  assert.equal((await app.get("/api/analytics/LU/nope")).status, 404);
  assert.equal((await app.get("/api/analytics/ZZ")).status, 404);
  const put = await fetch(app.base + "/api/analytics/LU", { method: "PUT" });
  assert.equal(put.status, 405);
});

test("a server with no prepared countries still starts and reports none", async () => {
  const empty = fs.mkdtempSync(path.join(output, "empty-"));
  const blank = await startServer({ output: empty });
  try {
    assert.deepEqual((await blank.get("/api/analytics")).body, []);
  } finally {
    await blank.stop();
  }
});

test("the development server serves the app from code/web", async () => {
  const dev = await startServer({ output, production: false });
  try {
    const page = await dev.get("/");
    assert.equal(page.status, 200);
    assert.match(page.text, /\/src\/main\.tsx/);
    const entry = await dev.get("/src/main.tsx");
    assert.equal(entry.status, 200);
    assert.match(entry.text, /Analytics/);
  } finally {
    await dev.stop();
  }
});

test("every pipeline script parses", () => {
  const directory = path.join(repoRoot, "code/pipeline");
  const scripts = fs
    .readdirSync(directory)
    .filter((name) => /\.(py|mjs)$/.test(name));
  assert.ok(scripts.length >= 6);
  for (const name of scripts) {
    const file = path.join(directory, name);
    const run = name.endsWith(".py")
      ? spawnSync(
          path.join(repoRoot, ".venv/bin/python"),
          ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", file],
          { encoding: "utf8" },
        )
      : spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(run.status, 0, name + "\n" + run.stderr);
  }
});
