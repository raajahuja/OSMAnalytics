// OSM extract -> real pipeline -> SQLite -> real HTTP API, with exact expected results.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, removeFixture, startServer } from "../helpers.mjs";

let output, app, dataset;
const bbox = "5.9,49.5,6.3,49.8";
const ids = (result) => result.body.features.map(({ id }) => id).sort();
const area = (name) => dataset.areas.find((item) => item.name === name);

before(async () => {
  output = buildFixture();
  app = await startServer({ output });
  dataset = (await app.get("/api/analytics/LU")).body;
});
after(async () => {
  await app?.stop();
  if (output) removeFixture(output);
});

test("the snapshot and country come from the extract", () => {
  assert.equal(dataset.snapshot, "2026-01-02T03:04:05Z");
  assert.equal(dataset.country.id, "LU");
  assert.equal(dataset.areas.length, 13);
  assert.equal(dataset.areas[0].id, "all");
});

test("objects outside every canton are excluded", async () => {
  assert.deepEqual(dataset.areas[0].objects, {
    node: 7,
    way: 6,
    relation: 4,
  });
  assert.equal((await app.get("/api/analytics/LU/object/node/106")).status, 404);
  assert.equal((await app.get("/api/analytics/LU/object/way/207")).status, 404);
});

test("a way crossing cantons counts in both but once nationally", async () => {
  const count = async (region) =>
    (await app.get(`/api/analytics/LU/tags?key=highway&region=${region}`)).body
      .rows.find((row) => row.value === "motorway").count;
  assert.equal(await count("all"), 1);
  assert.equal(await count("C01"), 1);
  assert.equal(await count("C02"), 1);
});

test("a node on a shared border belongs to exactly one canton", async () => {
  const object = (await app.get("/api/analytics/LU/object/node/105")).body;
  assert.deepEqual(object.regions, ["Canton 01"]);
});

test("geometry types survive the pipeline", async () => {
  const kinds = {
    "node/101": "Point",
    "way/201": "LineString",
    "way/203": "LineString",
    "way/204": "Polygon",
    "relation/301": "MultiPolygon",
    "relation/302": "GeometryCollection",
  };
  for (const [id, expected] of Object.entries(kinds)) {
    const object = await app.get("/api/analytics/LU/object/" + id);
    assert.equal(object.body.geometry, expected, id);
  }
});

test("a relation membership cycle resolves without hanging", async () => {
  for (const id of [303, 304]) {
    const object = await app.get("/api/analytics/LU/object/relation/" + id);
    assert.deepEqual(object.body.regions, ["Canton 01"]);
  }
});

test("feature queries honour key, value, kind, canton and viewport", async () => {
  const features = (query) =>
    app.get(`/api/analytics/LU/features?bbox=${bbox}&${query}`);
  assert.deepEqual(ids(await features("key=highway")), [
    "node/101",
    "node/104",
    "way/201",
    "way/202",
    "way/203",
    "way/208",
    "way/209",
  ]);
  assert.deepEqual(ids(await features("key=highway&value=motorway")), [
    "way/201",
  ]);
  assert.deepEqual(ids(await features("key=highway&kind=node")), [
    "node/101",
    "node/104",
  ]);
  assert.deepEqual(ids(await features("key=highway&region=C02")), ["way/201"]);
  const away = await app.get(
    "/api/analytics/LU/features?key=highway&bbox=6.2,49.7,6.3,49.8",
  );
  assert.deepEqual(ids(away), []);
});

test("multi-tag selections combine as any and all", async () => {
  const filters = JSON.stringify([
    { key: "barrier", values: ["gate"] },
    { key: "access", values: [] },
  ]);
  const any = await app.post("/api/analytics/LU/selection", { filters });
  assert.equal(any.body.matchCount, 2);
  assert.deepEqual(any.body.keys, [
    ["barrier", 2],
    ["access", 1],
  ]);
  const all = await app.post("/api/analytics/LU/selection", {
    filters,
    match: "all",
  });
  assert.equal(all.body.matchCount, 1);
  const shown = await app.post("/api/analytics/LU/features", {
    filters,
    match: "all",
    bbox,
  });
  assert.deepEqual(
    shown.body.features.map(({ id }) => id),
    ["node/107"],
  );
  assert.equal(shown.body.features[0].properties.tags.length, 2);
});

test("all keys covers every object and still honours other filters", async () => {
  const selection = (query) =>
    app.get("/api/analytics/LU/selection?filters=%5B%5D&allKeys=1" + query);
  assert.equal((await selection("")).body.matchCount, 17);
  assert.equal((await selection("&kind=node")).body.matchCount, 7);
  assert.equal((await selection("&region=C02")).body.keyCount, 3);
  const features = (query) =>
    app.get(
      `/api/analytics/LU/features?filters=%5B%5D&allKeys=1&bbox=${bbox}${query}`,
    );
  const everything = await features("");
  assert.equal(everything.body.features.length, 17);
  assert.equal(everything.body.features[0].properties.value, null);
  assert.deepEqual(everything.body.features[0].properties.tags, []);
  assert.deepEqual(ids(await features("&kind=way&region=C02")), [
    "way/201",
    "way/204",
  ]);
});

test("empty filters without all keys still match nothing", async () => {
  const { body } = await app.get(
    `/api/analytics/LU/features?filters=%5B%5D&bbox=${bbox}`,
  );
  assert.deepEqual(body.features, []);
  const counts = await app.get("/api/analytics/LU/selection?filters=%5B%5D");
  assert.equal(counts.body.matchCount, 0);
});

test("all keys is ignored when real tag rules are present", async () => {
  const { body } = await app.get(
    `/api/analytics/LU/features?key=building&allKeys=1&bbox=${bbox}`,
  );
  assert.deepEqual(ids({ body }), ["way/204"]);
});

test("a key is broken down by region with exact figures", async () => {
  const { status, body } = await app.get(
    "/api/analytics/LU/tag-regions?key=highway",
  );
  assert.equal(status, 200);
  assert.equal(body.total, 7);
  assert.equal(body.regions.length, 12);
  assert.deepEqual(
    body.regions.slice(0, 2).map(({ id, count }) => [id, count]),
    [
      ["C01", 7],
      ["C02", 1],
    ],
  );
  const c01 = body.regions[0];
  assert.equal(c01.name, "Canton 01");
  assert.equal(c01.keyCount, 7);
  assert.equal(c01.distinctValues, 6);
  assert.equal(c01.topValue, "service");
  assert.equal(c01.topCount, 2);
  assert.ok(c01.regionObjects > 7);
  assert.ok(c01.areaKm2 > 0);
  const empty = body.regions.find(({ id }) => id === "C05");
  assert.deepEqual(
    [empty.count, empty.keyCount, empty.topValue, empty.distinctValues],
    [0, 0, null, 0],
  );
});

test("region breakdown honours values and object type", async () => {
  const get = async (query) =>
    (await app.get("/api/analytics/LU/tag-regions?" + query)).body;
  const motorway = await get("key=highway&focus=motorway");
  assert.equal(motorway.total, 1);
  assert.deepEqual(
    motorway.regions.slice(0, 2).map(({ count }) => count),
    [1, 1],
  );
  assert.equal(motorway.regions[0].keyCount, 7);
  const two = await get("key=highway&focus=motorway&focus=service");
  assert.equal(two.total, 3);
  const nodes = await get("key=highway&kind=node");
  assert.equal(nodes.total, 2);
  assert.equal(nodes.regions[0].count, 2);
});

test("region breakdown rejects bad requests", async () => {
  for (const query of ["", "kind=node", "key=highway&kind=x"])
    assert.equal(
      (await app.get("/api/analytics/LU/tag-regions?" + query)).status,
      400,
      query,
    );
});

test("nearby sorts by distance and hides relations behind mapped objects", async () => {
  const { body } = await app.get(
    "/api/analytics/LU/nearby?lat=49.531&lon=5.931&radius=300",
  );
  assert.equal(body.features[0].id, "node/101");
  assert.equal(body.features[0].properties.distance, 0);
  assert.equal(body.features[0].properties.category, "highway=bus_stop");
  const distances = body.features.map(({ properties }) => properties.distance);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  assert.equal(body.total, body.features.length);
});

test("a point inside a polygon hole is not inside the polygon", async () => {
  const nearby = (lat, lon) =>
    app.get(`/api/analytics/LU/nearby?lat=${lat}&lon=${lon}&radius=25`);
  const forest = (result) =>
    result.body.features.some(({ id }) => id === "relation/301");
  assert.equal(forest(await nearby(49.54, 6.14)), true);
  assert.equal(forest(await nearby(49.525, 6.125)), false);
});

test("nearby rejects bad input", async () => {
  for (const query of [
    "lat=49&lon=6&radius=24",
    "lat=49&lon=6&radius=2001",
    "lat=91&lon=6&radius=100",
    "lat=49&lon=181&radius=100",
    "lat=&lon=6&radius=100",
    "lat=49&lon=6&radius=100.5",
    "lat=49&lon=6&radius=100&page=0",
  ])
    assert.equal(
      (await app.get("/api/analytics/LU/nearby?" + query)).status,
      400,
      query,
    );
});

test("tag tables page, sort, search and compare cantons", async () => {
  const values = (await app.get("/api/analytics/LU/tags?key=highway")).body;
  assert.equal(values.total, 6);
  assert.equal(values.tag.count, 7);
  assert.equal(values.tag.distinct_values, 6);
  assert.equal(values.rows[0].value, "service");
  assert.equal(values.rows[0].count, 2);
  assert.equal(values.comparison.C01, 7);
  assert.equal(values.comparison.C02, 1);
  const sorted = (await app.get("/api/analytics/LU/tags?key=highway&sort=name"))
    .body.rows.map(({ value }) => value);
  assert.deepEqual(sorted, [...sorted].sort());
  const searched = await app.get("/api/analytics/LU/tags?key=highway&q=MOTOR");
  assert.deepEqual(
    searched.body.rows.map(({ value }) => value),
    ["motorway"],
  );
});

test("CSV export carries context columns and neutralises formulas", async () => {
  const csv = await app.get("/api/analytics/LU/tags?key=name&format=csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  assert.match(csv.text, /^country,region_code,region,snapshot_utc,/);
  assert.match(csv.text, /"'=SUM\(A1\)"/);
  assert.doesNotMatch(csv.text, /,"=SUM/);
});

test("oversized POST bodies are refused", async () => {
  const big = await app.post("/api/analytics/LU/selection", {
    filters: "x".repeat(130 * 1024),
  });
  assert.equal(big.status, 413);
});

test("the map endpoint lists only place names", async () => {
  const { body } = await app.get("/api/analytics/LU/map");
  assert.ok(body.features.length > 0);
  assert.ok(body.features.every(({ properties }) => properties.layer === "place"));
  assert.ok(
    body.features.some(({ properties }) => properties.name === "Fixtureville"),
  );
});

test("vector tiles are served in byte ranges", async () => {
  const response = await fetch(app.base + "/tiles/LU.pmtiles", {
    headers: { Range: "bytes=0-6" },
  });
  assert.equal(response.status, 206);
  assert.match(response.headers.get("content-range"), /^bytes 0-6\/\d+$/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PMTiles");
  const missing = await fetch(app.base + "/tiles/ZZ.pmtiles");
  assert.equal(missing.status, 404);
  const escape = await fetch(app.base + "/tiles/..%2Fsecret.pmtiles");
  assert.equal(escape.status, 404);
});
