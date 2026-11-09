import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveImagery, tileRange } from "../../server/imagery.mjs";

function response() {
  const res = {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers = {}) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

test("tileRange covers Luxembourg at low and high zoom", () => {
  const [west, north, east, south] = tileRange(7);
  assert.ok(west <= east && north <= south);
  assert.equal(east, 66);
  assert.equal(west, 66);
  const [w12, , e12] = tileRange(12);
  assert.ok(e12 - w12 >= 8 && e12 - w12 <= 12);
});

test("tiles outside the zoom range or the country never reach the network", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Unexpected upstream request");
  try {
    for (const [z, x, y] of [
      [6, 33, 21],
      [20, 1, 1],
      [12, 0, 0],
    ]) {
      const res = response();
      await serveImagery(res, os.tmpdir(), z, x, y);
      assert.equal(res.status, 404);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cached tile is served from disk without a network call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-tiles-"));
  const [x, y] = tileRange(7);
  const file = path.join(directory, "LU-ortho-2025", "7", String(x));
  fs.mkdirSync(file, { recursive: true });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  fs.writeFileSync(path.join(file, y + ".jpeg"), bytes);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Unexpected upstream request");
  try {
    const res = response();
    await serveImagery(res, directory, 7, x, y);
    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "image/jpeg");
    assert.deepEqual(res.body, bytes);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed upstream tile returns 502 and is not cached", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-tiles-"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("nope", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  try {
    const res = response();
    await serveImagery(res, directory, 7, ...tileRange(7));
    assert.equal(res.status, 502);
    assert.equal(fs.existsSync(path.join(directory, "LU-ortho-2025")), false);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
