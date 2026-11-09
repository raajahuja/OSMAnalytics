import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createQueryPool } from "../../server/query-pool.mjs";

// A stand-in worker: answers after the delay given in the query string.
const workerSource = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", ({ id, path: url, method, body }) => {
  const query = new URL(url, "http://x").searchParams;
  if (query.get("crash")) process.exit(1);
  setTimeout(() => {
    parentPort.postMessage({ id, type: "head", status: 200, headers: { "content-type": "text/plain" } });
    parentPort.postMessage({ id, type: "chunk", data: Buffer.from(method + (body ? Buffer.from(body).toString() : "") + url) });
    parentPort.postMessage({ id, type: "end" });
  }, Number(query.get("ms") || 0));
});`;

function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-pool-"));
  const workerFile = path.join(root, "worker.mjs");
  fs.writeFileSync(workerFile, workerSource);
  fs.writeFileSync(path.join(root, "AT.sqlite"), "database");
  const pool = createQueryPool({
    analyticsDir: root,
    workerUrl: workerFile,
    cacheMinMs: 0,
    ...options,
  });
  return { pool, root };
}

function fakeResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.body = "";
  res.done = new Promise((resolve) => (res.resolve = resolve));
  res.writeHead = (status) => {
    res.status = status;
    res.headersSent = true;
  };
  res.write = (data) => (res.body += data.toString());
  res.end = (data) => {
    if (data) res.body += data.toString();
    res.writableFinished = true;
    res.resolve();
  };
  res.destroy = () => res.resolve();
  return res;
}

function ask(pool, target, method = "GET", body) {
  const res = fakeResponse();
  const url = new URL(target, "http://localhost");
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
  pool.handle(req, res, url);
  return res;
}

const elapsed = async (res, started = performance.now()) => {
  await res.done;
  return performance.now() - started;
};

test("a slow query doesn't delay a quick one", async (t) => {
  const { pool } = setup();
  t.after(() => pool.close());
  const slow = ask(pool, "/api/analytics/AT/features?ms=400");
  const started = performance.now();
  const quick = ask(pool, "/api/analytics/AT?ms=0");
  assert.ok((await elapsed(quick, started)) < 300);
  await slow.done;
  assert.equal(slow.status, 200);
});

test("one worker stays free for quick requests when heavy ones pile up", async (t) => {
  const { pool } = setup({ size: 2 });
  t.after(() => pool.close());
  const heavy = [
    ask(pool, "/api/analytics/AT/features?ms=400&a=1"),
    ask(pool, "/api/analytics/AT/features?ms=400&a=2"),
  ];
  const started = performance.now();
  const quick = ask(pool, "/api/analytics/AT/tags?ms=0");
  assert.ok((await elapsed(quick, started)) < 300);
  await Promise.all(heavy.map((res) => res.done));
});

test("POST bodies reach the worker and over-long ones are cut one byte past the limit", async (t) => {
  const { pool } = setup();
  t.after(() => pool.close());
  const small = ask(pool, "/api/analytics/AT/selection", "POST", "filters=x");
  await small.done;
  assert.match(small.body, /^POSTfilters=x/);
  const big = ask(pool, "/api/analytics/AT/selection", "POST", "x".repeat(200 * 1024));
  await big.done;
  assert.equal(big.body.length - "POST/api/analytics/AT/selection".length, 128 * 1024 + 1);
});

test("a repeated slow request is answered from the cache", async (t) => {
  const { pool } = setup();
  t.after(() => pool.close());
  const url = "/api/analytics/AT/freshness?ms=120";
  const first = ask(pool, url);
  await first.done;
  const started = performance.now();
  const second = ask(pool, url);
  assert.ok((await elapsed(second, started)) < 60);
  assert.equal(second.body, first.body);
});

test("different POST bodies don't share a cache entry", async (t) => {
  const { pool } = setup();
  t.after(() => pool.close());
  const a = ask(pool, "/api/analytics/AT/selection", "POST", "filters=a");
  await a.done;
  const b = ask(pool, "/api/analytics/AT/selection", "POST", "filters=b");
  await b.done;
  assert.notEqual(a.body, b.body);
});

test("rebuilding a database invalidates its cached answers", async (t) => {
  const { pool, root } = setup();
  t.after(() => pool.close());
  const url = "/api/analytics/AT/freshness?ms=120";
  await ask(pool, url).done;
  const replacement = path.join(root, "new");
  fs.writeFileSync(replacement, "rebuilt database");
  fs.renameSync(replacement, path.join(root, "AT.sqlite"));
  const started = performance.now();
  await ask(pool, url).done;
  assert.ok(performance.now() - started >= 100);
});

test("CSV exports are never cached", async (t) => {
  const { pool } = setup();
  t.after(() => pool.close());
  const url = "/api/analytics/AT/tags?format=csv&ms=120";
  await ask(pool, url).done;
  const started = performance.now();
  await ask(pool, url).done;
  assert.ok(performance.now() - started >= 100);
});

test("a request the page cancelled while waiting never runs", async (t) => {
  const { pool } = setup({ size: 1 });
  t.after(() => pool.close());
  const running = ask(pool, "/api/analytics/AT?ms=150");
  const cancelled = ask(pool, "/api/analytics/AT?ms=0&id=cancelled");
  cancelled.emit("close");
  await running.done;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(cancelled.status, undefined);
});

test("a crashed worker answers with an error and is replaced", async (t) => {
  const { pool } = setup({ size: 1 });
  t.after(() => pool.close());
  const crashed = ask(pool, "/api/analytics/AT?crash=1");
  await crashed.done;
  assert.equal(crashed.status, 503);
  const next = ask(pool, "/api/analytics/AT?ms=0");
  await next.done;
  assert.equal(next.status, 200);
});

test("a query past its time limit gets a 504 and its worker is replaced", async (t) => {
  const { pool } = setup({ size: 1, timeoutMs: 60 });
  t.after(() => pool.close());
  const slow = ask(pool, "/api/analytics/AT/features?ms=5000");
  await slow.done;
  assert.equal(slow.status, 504);
  const next = ask(pool, "/api/analytics/AT?ms=0");
  await next.done;
  assert.equal(next.status, 200);
});

test("a cancelled query stops running instead of holding its worker", async (t) => {
  const { pool } = setup({ size: 1, abandonGraceMs: 10 });
  t.after(() => pool.close());
  const cancelled = ask(pool, "/api/analytics/AT/features?ms=5000");
  await new Promise((resolve) => setTimeout(resolve, 30));
  cancelled.emit("close");
  const started = performance.now();
  const next = ask(pool, "/api/analytics/AT?ms=0");
  assert.ok((await elapsed(next, started)) < 1500);
  assert.equal(next.status, 200);
});

test("a full queue refuses new work with a retry hint", async (t) => {
  const { pool } = setup({ size: 1, queueLimit: 1 });
  t.after(() => pool.close());
  const running = ask(pool, "/api/analytics/AT?ms=150&a=1");
  const queued = ask(pool, "/api/analytics/AT?ms=0&a=2");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refused = ask(pool, "/api/analytics/AT?ms=0&a=3");
  await refused.done;
  assert.equal(refused.status, 503);
  await Promise.all([running.done, queued.done]);
  assert.equal(queued.status, 200);
});
