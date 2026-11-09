// Shared by the Node test tiers: builds the fixture database and runs the real server.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const realDatabase = path.join(repoRoot, "output/analytics/LU.sqlite");
const python = path.join(repoRoot, ".venv/bin/python");

export function buildFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-fixture-"));
  const result = spawnSync(
    python,
    [path.join(repoRoot, "code/tests/fixtures/build_fixture.py"), directory],
    {
      encoding: "utf8",
      // The fixture is tiny, so these make it use every precomputed path.
      env: {
        ...process.env,
        WAYFINDER_LIST_MIN: "1",
        WAYFINDER_SEARCH_MIN_VALUES: "1",
        WAYFINDER_ROLLUP_MIN: "1",
      },
    },
  );
  if (result.status !== 0)
    throw Error("Fixture build failed:\n" + result.stdout + result.stderr);
  return directory;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startServer({
  output,
  production = true,
  entry = "code/server/index.mjs",
} = {}) {
  // The dev server also binds port + 1 for hot reload.
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  if (production) env.NODE_ENV = "production";
  else delete env.NODE_ENV;
  if (output) env.WAYFINDER_OUTPUT = output;
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  const base = `http://127.0.0.1:${port}`;
  const server = {
    base,
    port,
    child,
    logs: () => logs,
    alive: () => child.exitCode === null && child.signalCode === null,
    async get(pathname) {
      const response = await fetch(base + pathname);
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: response.status, headers: response.headers, body, text };
    },
    async post(pathname, form) {
      const response = await fetch(base + pathname, {
        method: "POST",
        body: new URLSearchParams(form),
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      if (!server.alive()) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!server.alive()) throw Error("Server exited early:\n" + logs);
    try {
      await fetch(base + "/api/analytics");
      return server;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await server.stop();
  throw Error("Server startup timed out:\n" + logs);
}

export const removeFixture = (directory) =>
  fs.rmSync(directory, { recursive: true, force: true });
