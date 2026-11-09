// Pre-builds a country's base map and region outlines as one PMTiles file, so the
// server no longer draws the base map for each view. Needs tippecanoe.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeGeometry } from "../server/geometry.mjs";

const [database, output] = process.argv.slice(2);
const MAIN_ROADS = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"]);
const MINOR_ROADS = new Set(["unclassified", "residential", "living_street", "service", "track"]);
const PATHS = new Set(["footway", "cycleway", "path", "pedestrian", "steps"]);

const db = new DatabaseSync(database, { readOnly: true });
const working = mkdtempSync(path.join(path.dirname(output), "tiles-"));
const source = path.join(working, "features.ndjson");
const file = openSync(source, "w");
let buffered = [];
let size = 0;
const flush = () => {
  if (buffered.length) writeSync(file, buffered.join(""));
  buffered = [];
  size = 0;
};
const write = (layer, minzoom, maxzoom, properties, geometry) => {
  const line =
    JSON.stringify({
      type: "Feature",
      tippecanoe: { layer, minzoom, maxzoom },
      properties,
      geometry,
    }) + "\n";
  buffered.push(line);
  size += line.length;
  if (size > 8_000_000) flush();
};

const context = JSON.parse(db.prepare("SELECT document FROM map_context").get().document);
for (const { properties, geometry } of context.features) {
  if (properties.layer === "canton")
    write("regions", 4, 14, { name: properties.name }, geometry);
  else if (properties.layer === "roads")
    write("context_roads", 4, 10, {}, geometry);
}

const keys = new Map(db.prepare("SELECT key, id FROM tag_key_names").all().map(({ key, id }) => [key, id]));
const features = db.prepare(`
  SELECT f.kind, f.label, f.geometry, v.value
  FROM map_tags t
  CROSS JOIN map_features f ON f.fid = t.fid
  CROSS JOIN tag_value_names v ON v.id = t.value_id
  WHERE t.key_id = ?`);
const each = (key, visit) => {
  if (!keys.has(key)) return;
  for (const row of features.iterate(keys.get(key))) visit(row);
};
each("highway", ({ kind, label, geometry, value }) => {
  if (kind !== "way") return;
  const minzoom = MAIN_ROADS.has(value) ? 9 : MINOR_ROADS.has(value) ? 11 : PATHS.has(value) ? 12 : null;
  if (minzoom === null) return;
  const properties = { main: MAIN_ROADS.has(value) ? 1 : 0 };
  if (label) properties.name = label;
  write("roads", minzoom, 14, properties, decodeGeometry(geometry));
});
each("waterway", ({ kind, geometry }) => {
  if (kind === "way") write("water", 10, 14, {}, decodeGeometry(geometry));
});
each("natural", ({ kind, geometry, value }) => {
  if (value === "water" && kind !== "node")
    write("water", 10, 14, {}, decodeGeometry(geometry));
});
each("building", ({ kind, geometry }) => {
  if (kind === "way") write("buildings", 14, 14, {}, decodeGeometry(geometry));
});
flush();
closeSync(file);
db.close();

const result = spawnSync(
  process.env.WAYFINDER_TIPPECANOE || "tippecanoe",
  [
    "--force",
    "--quiet",
    "--no-progress-indicator",
    "--read-parallel",
    "--minimum-zoom=4",
    "--maximum-zoom=14",
    "--simplification=4",
    "--no-tile-size-limit",
    "--no-feature-limit",
    "--output=" + output,
    source,
  ],
  { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
);
rmSync(working, { recursive: true, force: true });
if (result.error) throw Error("tippecanoe could not start: " + result.error.message);
if (result.status !== 0) throw Error("tippecanoe failed: " + result.stderr);
