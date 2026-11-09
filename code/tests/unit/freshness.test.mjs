import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { queryFreshness } from "../../server/freshness.mjs";

const snapshot = "2026-01-01T00:00:00Z";
const year = 31_557_600;
const now = Date.parse(snapshot) / 1000;
const area = { id: "all", name: "Test", bounds: [0, 0, 1, 1] };
const dataset = {
  snapshot,
  areas: [
    area,
    { id: "A", name: "Area A", bounds: [0, 0, 1, 1] },
    { id: "B", name: "Area B", bounds: [0, 0, 1, 1] },
  ],
};
const all = { sql: "SELECT fid FROM map_features", parameters: [] };

function database(objects) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE map_features(fid INTEGER PRIMARY KEY, kind, osm_id, label);
    CREATE TABLE feature_freshness(fid INTEGER PRIMARY KEY, version, edited, lon, lat);
    CREATE TABLE feature_regions(fid, region);
  `);
  const feature = db.prepare("INSERT INTO map_features VALUES (?, 'way', ?, ?)");
  const fresh = db.prepare("INSERT INTO feature_freshness VALUES (?, ?, ?, ?, ?)");
  const region = db.prepare("INSERT INTO feature_regions VALUES (?, ?)");
  objects.forEach((item, index) => {
    const fid = index + 1;
    feature.run(fid, 1000 + fid, item.label ?? null);
    fresh.run(fid, item.version ?? 1, item.edited, item.lon ?? 0.5, item.lat ?? 0.5);
    region.run(fid, item.region ?? 0);
  });
  return db;
}
const run = (objects) => {
  const db = database(objects);
  const result = queryFreshness(db, dataset, area, all, all);
  db.close();
  return result;
};
const ago = (years) => now - years * year;

test("stale and recent split exactly at their thresholds", () => {
  const result = run([
    { edited: ago(3) - 1 },
    { edited: ago(3) },
    { edited: ago(1) - 1 },
    { edited: ago(1) },
  ]);
  assert.equal(result.objects, 4);
  assert.equal(result.stale, 1);
  assert.equal(result.recent, 1);
});

test("the median, average and highest version are computed", () => {
  const result = run([
    { edited: ago(5), version: 1 },
    { edited: ago(4), version: 2 },
    { edited: ago(1), version: 9 },
  ]);
  assert.equal(result.medianEdited, ago(4));
  assert.equal(result.averageVersion, 4);
  assert.equal(result.maxVersion, 9);
});

test("objects without a date are left out", () => {
  const result = run([{ edited: ago(1) }, { edited: null }]);
  assert.equal(result.objects, 1);
});

test("an empty selection returns zeros without failing", () => {
  const result = run([]);
  assert.equal(result.objects, 0);
  assert.equal(result.medianEdited, null);
  assert.deepEqual(result.years, []);
  assert.deepEqual(result.cells, []);
  assert.deepEqual(result.mostEdited, []);
});

test("years without edits still appear on the timeline", () => {
  const result = run([
    { edited: Date.UTC(2018, 5, 1) / 1000 },
    { edited: Date.UTC(2021, 5, 1) / 1000 },
  ]);
  assert.deepEqual(result.years, [
    { year: 2018, objects: 1 },
    { year: 2019, objects: 0 },
    { year: 2020, objects: 0 },
    { year: 2021, objects: 1 },
  ]);
});

test("ranked lists are capped, ordered and stable on ties", () => {
  const objects = Array.from({ length: 30 }, (_, index) => ({
    edited: ago(1 + index / 10),
    version: 1 + (index % 3),
  }));
  const { mostEdited, oldest } = run(objects);
  assert.equal(mostEdited.length, 15);
  assert.equal(oldest.length, 15);
  assert.equal(mostEdited[0].version, 3);
  assert.equal(mostEdited[0].id, 1003);
  assert.equal(oldest[0].id, 1030);
  for (let index = 1; index < oldest.length; index++)
    assert.ok(oldest[index].edited >= oldest[index - 1].edited);
});

test("sparse grid squares are hidden and outside centres ignored", () => {
  const dense = Array.from({ length: 5 }, () => ({
    edited: ago(5),
    lon: 0.1,
    lat: 0.1,
  }));
  const sparse = Array.from({ length: 4 }, () => ({
    edited: ago(5),
    lon: 0.9,
    lat: 0.9,
  }));
  const outside = Array.from({ length: 9 }, () => ({
    edited: ago(5),
    lon: 40,
    lat: 40,
  }));
  const { cells, objects } = run([...dense, ...sparse, ...outside]);
  assert.equal(objects, 18);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].objects, 5);
  assert.equal(cells[0].stale, 5);
  const [west, south, east, north] = cells[0].bounds;
  assert.ok(west <= 0.1 && east > 0.1 && south <= 0.1 && north > 0.1);
});

test("regions are ranked with the stalest first", () => {
  const { regions } = run([
    { edited: ago(5), region: 1 },
    { edited: ago(1), region: 0 },
  ]);
  assert.deepEqual(
    regions.map(({ id }) => id),
    ["B", "A"],
  );
  assert.equal(regions[0].stale, 1);
  assert.ok(Math.abs(regions[0].averageAgeYears - 5) < 1e-6);
});

test("a missing snapshot date still produces results", () => {
  const db = database([{ edited: ago(1) }]);
  const result = queryFreshness(
    db,
    { ...dataset, snapshot: null },
    area,
    all,
    all,
  );
  db.close();
  assert.equal(result.objects, 1);
});
