// The one place that knows the repository layout. WAYFINDER_INPUT and
// WAYFINDER_OUTPUT let tests and deployments point at other data folders.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const inputDir = path.resolve(
  process.env.WAYFINDER_INPUT || path.join(repoRoot, "input"),
);
export const outputDir = path.resolve(
  process.env.WAYFINDER_OUTPUT || path.join(repoRoot, "output"),
);
export const webRoot = path.join(repoRoot, "code/web");
export const webDist = path.join(repoRoot, "output/web");
export const analyticsDir = path.join(outputDir, "analytics");
export const imageryDir = path.join(outputDir, "cache/imagery");
