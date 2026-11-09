// Prepares a fresh clone: checks the required tools, then creates the Python
// environment that the build pipeline runs in.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../server/paths.mjs";

const fail = (message) => {
  console.error("\n" + message);
  process.exit(1);
};
const atLeast = ([major, minor], [wantMajor, wantMinor]) =>
  major > wantMajor || (major === wantMajor && minor >= wantMinor);

const node = process.versions.node.split(".").map(Number);
if (!atLeast(node, [22, 13]))
  fail(`Node.js 22.13 or newer is required. This is ${process.versions.node}.`);

function pythonVersion(command) {
  const result = spawnSync(
    command,
    ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim().split(" ").map(Number) : null;
}

const python = [process.env.PYTHON, "python3", "python"]
  .filter(Boolean)
  .find((command) => {
    const version = pythonVersion(command);
    return version && atLeast(version, [3, 10]);
  });
if (!python)
  fail("Python 3.10 or newer is required. Set PYTHON if it isn't on your PATH.");

function run(command, args, problem) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error || result.status !== 0) fail(problem);
}

const venv = path.join(repoRoot, ".venv/bin/python");
if (!existsSync(venv)) {
  console.log("Creating the Python environment in .venv");
  run(python, ["-m", "venv", ".venv"], "Could not create the Python environment.");
}
console.log("Installing the Python packages");
run(
  venv,
  ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"],
  "Could not install the packages in requirements.txt.",
);
run(
  venv,
  ["-c", "import osmium, pyproj, shapely"],
  "The Python packages installed but could not be loaded.",
);

const tippecanoe = process.env.WAYFINDER_TIPPECANOE || "tippecanoe";
if (spawnSync(tippecanoe, ["--version"]).error)
  fail(
    "tippecanoe is required to build a country's map.\n" +
      "  macOS: brew install tippecanoe\n" +
      "  Linux: build it from https://github.com/felt/tippecanoe\n" +
      "Then run npm run setup again.",
  );

console.log("\nReady. Start the app with: npm run dev");
