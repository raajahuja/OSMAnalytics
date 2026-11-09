import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { buildFixture, removeFixture, repoRoot } from "../helpers.mjs";

function raw(port, target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: target, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function start(env) {
  const output = buildFixture();
  const port = 5300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ["--no-warnings", "code/server/index.mjs"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), WAYFINDER_OUTPUT: output, ...env },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await raw(port, "/api/health");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    port,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      removeFixture(output);
    },
  };
}

test("public mode has no build routes, and limits each client", async (t) => {
  const server = await start({ WAYFINDER_PUBLIC: "1", WAYFINDER_RATE_BURST: "6", WAYFINDER_RATE_PER_SECOND: "0.01" });
  t.after(() => server.stop());
  const spoofed = { Host: "localhost", Origin: "http://localhost" };
  const build = await raw(server.port, "/api/countries/AT/build", { method: "POST", headers: spoofed });
  assert.equal(build.status, 404);
  assert.equal((await raw(server.port, "/api/countries")).status, 404);
  const config = await raw(server.port, "/api/config");
  assert.equal(JSON.parse(config.body).publicSite, true);
  const redirect = await raw(server.port, "/countries");
  assert.equal(redirect.status, 302);
  let last;
  for (let i = 0; i < 8; i++) last = await raw(server.port, "/api/analytics");
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers["retry-after"]) >= 1);
  assert.equal((await raw(server.port, "/api/health")).status, 200);
});

test("the country list is only cached on a public site", async (t) => {
  const local = await start({});
  t.after(() => local.stop());
  const onPublicSite = await start({ WAYFINDER_PUBLIC: "1" });
  t.after(() => onPublicSite.stop());
  const header = async (server) =>
    (await raw(server.port, "/api/analytics")).headers["cache-control"];
  assert.equal(await header(local), "no-store");
  assert.equal(await header(onPublicSite), "public, max-age=60");
});

test("responses are compressed, and versioned URLs are cacheable forever", async (t) => {
  const server = await start({});
  t.after(() => server.stop());
  const summary = JSON.parse((await raw(server.port, "/api/analytics/LU")).body);
  assert.match(summary.version, /^[0-9a-f]{12}$/);
  const target = "/api/analytics/LU/tags?region=all";

  const brotli = await raw(server.port, target + "&v=" + summary.version, { headers: { "Accept-Encoding": "br, gzip" } });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.equal(brotli.headers.vary, "Accept-Encoding");
  assert.ok(JSON.parse(brotliDecompressSync(brotli.body)).rows.length);
  assert.match(brotli.headers["cache-control"], /immutable/);

  const gzip = await raw(server.port, target, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.ok(JSON.parse(gunzipSync(gzip.body)).rows.length);
  assert.equal(gzip.headers["cache-control"], "public, max-age=60");

  const plain = await raw(server.port, target + "&v=stale");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers["cache-control"], "public, max-age=60");
  assert.ok(JSON.parse(plain.body).rows.length);

  const missing = await raw(server.port, "/api/analytics/LU/selection?v=" + summary.version);
  assert.equal(missing.status, 400);
  assert.equal(missing.headers["cache-control"], "no-store");
});

test("the production server starts without development dependencies being loaded", async (t) => {
  const server = await start({ HOST: "127.0.0.1" });
  t.after(() => server.stop());
  const health = await raw(server.port, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, "ok");
});
