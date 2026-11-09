import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputDir } from "../server/paths.mjs";

const raw = pathToFileURL(inputDir + "/");
const pbf = "https://download.geofabrik.de/europe/luxembourg-latest.osm.pbf";
const cantons =
  "https://download.data.public.lu/resources/cantons-in-luxembourg-2026/20260121-020309/cantons-lux-2026.geojson";

async function fetchFile(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok)
    throw new Error("Download failed (" + response.status + ") " + url);
  return Buffer.from(await response.arrayBuffer());
}

const checksum = (bytes) => createHash("md5").update(bytes).digest("hex");

async function verifyOrDownload(url, name, expected) {
  if (!/^[a-f0-9]{32}$/.test(expected))
    throw new Error("Invalid published checksum.");
  const target = new URL(name, raw);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  const existing = await readFile(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && checksum(existing) === expected) {
    console.log("Verified cached " + name);
    return;
  }
  const bytes = await fetchFile(url);
  if (checksum(bytes) !== expected)
    throw new Error(
      "Checksum mismatch for " + name + ". Try downloading again.",
    );
  const temporary = new URL(name + "." + randomUUID() + ".part", raw);
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  console.log("Downloaded and verified " + name);
}

const expected = (await fetchFile(pbf + ".md5")).toString().split(/\s/)[0];
await Promise.all([
  verifyOrDownload(pbf, "osm/luxembourg.osm.pbf", expected),
  verifyOrDownload(
    cantons,
    "boundaries/cantons.geojson",
    "9bcfa564f92317770d2d44af36da1166",
  ),
]);
