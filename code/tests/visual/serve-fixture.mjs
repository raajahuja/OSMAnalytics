// Runs the production server on the fixture so screenshots never change with OSM data.
import { spawn } from "node:child_process";
import { buildFixture, removeFixture, repoRoot } from "../helpers.mjs";

const output = buildFixture();
const child = spawn(process.execPath, ["code/server/index.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: process.argv[2],
    WAYFINDER_OUTPUT: output,
  },
});
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => {
  removeFixture(output);
  process.exit(code ?? 0);
});
