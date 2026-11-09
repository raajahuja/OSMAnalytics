// OSM metadata -> real pipeline -> freshness API, with exact expected results.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, removeFixture, startServer } from "../helpers.mjs";

let output, app;
const api = "/api/analytics/LU/freshness";
const epoch = (text) => Date.parse(text) / 1000;
const get = async (query) => (await app.get(api + "?" + query)).body;

before(async () => {
  output = buildFixture();
  app = await startServer({ output });
});
after(async () => {
  await app?.stop();
  if (output) removeFixture(output);
});

test("a key's objects are summarised from their real history", async () => {
  const body = await get("key=highway");
  assert.equal(body.objects, 7);
  assert.equal(body.stale, 3);
  assert.equal(body.recent, 3);
  assert.equal(body.medianEdited, epoch("2024-02-02T00:00:00Z"));
  assert.equal(body.maxVersion, 40);
  assert.ok(Math.abs(body.averageVersion - 55 / 7) < 1e-9);
  assert.equal(body.staleYears, 3);
  assert.equal(body.staleYear, 2023);
});

test("the timeline runs from the oldest edit to the newest", async () => {
  const { years } = await get("key=highway");
  assert.equal(years[0].year, 2015);
  assert.equal(years.at(-1).year, 2025);
  assert.equal(years.length, 11);
  assert.equal(years.reduce((sum, { objects }) => sum + objects, 0), 7);
});

test("ranked lists name the right objects", async () => {
  const { mostEdited, oldest } = await get("key=highway");
  assert.deepEqual(mostEdited[0], {
    kind: "way",
    id: 201,
    label: "A1",
    version: 40,
    edited: epoch("2019-03-01T00:00:00Z"),
  });
  assert.equal(oldest[0].kind + oldest[0].id, "node101");
});

test("relations keep their own version and date", async () => {
  const body = await get("key=landuse");
  assert.equal(body.objects, 1);
  assert.equal(body.mostEdited[0].kind, "relation");
  assert.equal(body.mostEdited[0].edited, epoch("2025-11-20T00:00:00Z"));
});

test("region and object type narrow the summary", async () => {
  assert.equal((await get("key=highway&region=C02")).objects, 1);
  assert.equal((await get("key=highway&region=C02")).stale, 1);
  assert.equal((await get("key=highway&kind=node")).objects, 2);
});

test("the area comparison ignores the selected region", async () => {
  const { regions } = await get("key=highway&region=C02");
  const objects = Object.fromEntries(regions.map((r) => [r.id, r.objects]));
  assert.deepEqual(objects, { C01: 7, C02: 1 });
});

test("multi-key selections count each object once", async () => {
  const filters = encodeURIComponent(
    JSON.stringify([
      { key: "barrier", values: ["gate"] },
      { key: "access", values: [] },
    ]),
  );
  assert.equal((await get(`filters=${filters}`)).objects, 2);
  assert.equal((await get(`filters=${filters}&match=all`)).objects, 1);
});

test("a combined selection compares areas and years like a single key", async () => {
  const filters = encodeURIComponent(
    JSON.stringify([
      { key: "highway", values: [] },
      { key: "landuse", values: [] },
    ]),
  );
  const combined = await get(`filters=${filters}`);
  const single = await get("key=highway");
  assert.equal(combined.objects, single.objects + 1);
  assert.equal(combined.sample, null);
  const total = (body) => body.years.reduce((sum, { objects }) => sum + objects, 0);
  assert.equal(total(combined), combined.objects);
  const area = Object.fromEntries(combined.regions.map((r) => [r.id, r.objects]));
  assert.ok(area.C01 >= 7);
});

test("a large combined selection is estimated from a labelled sample", async () => {
  const sampled = await startServer({
    output,
    env: { WAYFINDER_FRESHNESS_SAMPLE: "3" },
  });
  try {
    const filters = encodeURIComponent(
      JSON.stringify([
        { key: "highway", values: [] },
        { key: "landuse", values: [] },
      ]),
    );
    const { body } = await sampled.get(api + "?filters=" + filters);
    // The hash cut keeps about, not exactly, the requested number.
    assert.ok(body.sample > 0 && body.sample < 8, String(body.sample));
    // Counts are scaled back up to the whole selection of 8 dated objects.
    assert.equal(body.objects, 8);
  } finally {
    await sampled.stop();
  }
});

test("no tag filter covers every object", async () => {
  const body = await get("filters=%5B%5D");
  assert.equal(body.objects, 17);
});

test("POST works like the other filtered endpoints", async () => {
  const { status, body } = await app.post(api, {
    filters: JSON.stringify([{ key: "highway", values: ["motorway"] }]),
  });
  assert.equal(status, 200);
  assert.equal(body.objects, 1);
});

test("invalid selections are refused", async () => {
  for (const query of ["filters=%7B", "key=highway&region=ZZ", "key=a&kind=x"])
    assert.equal((await app.get(api + "?" + query)).status, 400, query);
});

test("object details report the version and last edit", async () => {
  const { body } = await app.get("/api/analytics/LU/object/way/201");
  assert.equal(body.version, 40);
  assert.equal(body.edited, epoch("2019-03-01T00:00:00Z"));
});

test("a country across 180 degrees uses continuous grid longitudes", async () => {
  const { body } = await app.get(
    "/api/analytics/XX/freshness?filters=%5B%5D",
  );
  assert.equal(body.objects, 7);
});
