// Bugs found by the audit, kept here so they stay fixed. See AUDIT.md.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { queryNearby } from "../../server/nearby.mjs";
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

function rawRequest(port, target) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
    socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

test("right-click menu is wide enough and clamped to its own width", () => {
  const css = fs.readFileSync(
    path.join(repoRoot, "code/web/src/analytics.css"),
    "utf8",
  );
  const width = Number(
    /\.ax-map-context-menu \{\s*width: (\d+)px;/.exec(css)?.[1],
  );
  assert.ok(width >= 190, "Query nearby features needs at least 190px");
  const map = fs.readFileSync(
    path.join(repoRoot, "code/web/src/AnalyticsFeatureMap.tsx"),
    "utf8",
  );
  const clamp = Number(/clientWidth - (\d+)\)\)/.exec(map)?.[1]);
  assert.ok(clamp >= width + 6, "The menu must not overflow the right edge");
});

test("source files no longer refer to the old folder layout", () => {
  const stale =
    /["'`/](data\/(analytics|overture)|scripts\/(prepare|download)|server\/(index|routing)\.mjs)/;
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  const sources = [
    ...walk(path.join(repoRoot, "code/server")),
    ...walk(path.join(repoRoot, "code/pipeline")),
    path.join(repoRoot, "package.json"),
  ];
  for (const file of sources) {
    const relevant = fs
      .readFileSync(file, "utf8")
      .replaceAll("code/server/", "");
    assert.doesNotMatch(relevant, stale, file);
  }
});

test("static file serving cannot escape the build folder", async () => {
  for (const target of [
    "/../../package.json",
    "/%2e%2e/%2e%2e/package.json",
    "/..%2f..%2fpackage.json",
  ]) {
    const reply = await rawRequest(app.port, target);
    assert.doesNotMatch(reply, /wayfinder-osm-routing/, target);
  }
});

test("hostile tag text cannot alter the SQL", async () => {
  const key = encodeURIComponent("x' OR '1'='1");
  const { status, body } = await app.get(
    `/api/analytics/LU/features?key=${key}&bbox=5.9,49.5,6.3,49.8`,
  );
  assert.equal(status, 200);
  assert.deepEqual(body.features, []);
});

test("the country name in the URL cannot select another file", async () => {
  for (const target of ["../LU", "lu", "LUX", "L%2fU"])
    assert.equal(
      (await app.get("/api/analytics/" + target)).status,
      404,
      target,
    );
});

test("a malformed request path gets 400 and the server survives (C1)", async () => {
  const victim = await startServer({ output });
  try {
    const reply = await rawRequest(victim.port, "//");
    assert.match(reply, /^HTTP\/1\.1 400/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(victim.alive(), true, victim.logs());
    assert.equal((await victim.get("/api/analytics")).status, 200);
  } finally {
    await victim.stop();
  }
});

test("tag search folds case for accented letters (C2)", async () => {
  const total = async (q) =>
    (
      await app.get(
        "/api/analytics/LU/tags?key=name&view=options&q=" +
          encodeURIComponent(q),
      )
    ).body.total;
  assert.equal(await total("église"), 1);
  assert.equal(await total("Église"), 1);
  assert.equal(await total("ÉGLISE"), 1);
  assert.equal(await total("zzz"), 0);
});

test("tag key search also folds case (C2)", async () => {
  const { body } = await app.get("/api/analytics/LU/tags?view=options&q=HIGHW");
  assert.deepEqual(
    body.rows.map(({ key }) => key),
    ["highway"],
  );
});

test("nearby searches both sides of the antimeridian (A3)", () => {
  const seen = [];
  const db = {
    prepare: () => ({
      iterate: (...parameters) => {
        seen.push(parameters.slice(3));
        return [];
      },
      get: () => undefined,
      all: () => [],
    }),
  };
  queryNearby(
    db,
    new URLSearchParams({ lat: "0", lon: "179.999", radius: "2000" }),
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 180);
  assert.equal(seen[1][1], -180);
});
