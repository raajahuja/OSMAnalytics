// Country XX: no national settings, 40 regions, straddling the antimeridian.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, removeFixture, startServer } from "../helpers.mjs";

let output, app, dataset;
const api = "/api/analytics/XX";
const ids = (result) => result.body.features.map(({ id }) => id).sort();

before(async () => {
  output = buildFixture();
  app = await startServer({ output });
  dataset = (await app.get(api)).body;
});
after(async () => {
  await app?.stop();
  if (output) removeFixture(output);
});

test("the server lists every prepared country with its own settings", async () => {
  const countries = (await app.get("/api/analytics")).body;
  assert.deepEqual(
    countries.map(({ id }) => id),
    ["XX", "LU"],
  );
  assert.equal(dataset.country.division, "Cell");
  assert.equal(dataset.boundaryCredit, "Fixture Survey");
  assert.equal(dataset.boundaryLicense, "CC0");
  assert.equal(dataset.areas.length, 41);
});

test("regions past the 31st filter correctly (A2)", async () => {
  const bbox = "-180,-17.1,180,-16.7";
  const features = (region) =>
    app.get(`${api}/features?key=amenity&region=${region}&bbox=${bbox}`);
  // With 32-bit masks, R33 wrapped round and also matched R01.
  assert.deepEqual(ids(await features("R33")), ["node/1003"]);
  assert.deepEqual(ids(await features("R01")), ["node/1004"]);
  assert.deepEqual(ids(await features("R10")), ["node/1001"]);
  const shops = await app.get(
    `${api}/features?key=shop&region=R40&bbox=${bbox}`,
  );
  assert.deepEqual(ids(shops), ["node/1005"]);
});

test("object details name regions past the 31st (A2)", async () => {
  assert.deepEqual((await app.get(`${api}/object/node/1003`)).body.regions, [
    "Cell 33",
  ]);
  assert.deepEqual((await app.get(`${api}/object/node/1005`)).body.regions, [
    "Cell 40",
  ]);
});

test("multi-key counts honour regions past the 31st (A2)", async () => {
  const filters = JSON.stringify([
    { key: "amenity", values: [] },
    { key: "name", values: [] },
  ]);
  const { body } = await app.post(api + "/selection", {
    filters,
    region: "R33",
    match: "all",
  });
  assert.equal(body.matchCount, 1);
});

test("lengths are correct with the automatic projection (A1)", () => {
  const roads = dataset.areas[0].themes.roads;
  const [, count, kilometres] = roads.find(([value]) => value === "primary");
  assert.equal(count, 2);
  assert.ok(Math.abs(kilometres - 21.28) < 0.1, String(kilometres));
});

test("a country across 180 reports continuous bounds and outlines (A3)", async () => {
  const [west, , east] = dataset.areas[0].bounds;
  assert.ok(Math.abs(west - 179) < 0.01, String(west));
  assert.ok(Math.abs(east - 181) < 0.01, String(east));
});

test("filtering by a region east of 180 still finds it (A3)", async () => {
  const { body } = await app.get(
    `${api}/features?key=amenity&region=R11&bbox=179.9,-17,180.1,-16.9`,
  );
  assert.deepEqual(
    body.features.map(({ id }) => id),
    ["node/1002"],
  );
});

test("non-Latin search folds case (C2)", async () => {
  const search = (q) =>
    app.get(`${api}/tags?key=name&view=options&q=${encodeURIComponent(q)}`);
  for (const q of ["москва", "МОСКВА", "Москва"])
    assert.deepEqual(
      (await search(q)).body.rows.map(({ value }) => value),
      ["МОСКВА кафе"],
      q,
    );
});

test("a viewport across 180 returns both sides in the map's frame (A3)", async () => {
  const { status, body } = await app.get(
    `${api}/features?key=amenity&bbox=179.9,-17,180.1,-16.9`,
  );
  assert.equal(status, 200);
  const longitude = Object.fromEntries(
    body.features.map(({ id, geometry }) => [id, geometry.coordinates[0]]),
  );
  assert.deepEqual(Object.keys(longitude).sort(), ["node/1001", "node/1002"]);
  assert.equal(longitude["node/1001"], 179.995);
  assert.ok(Math.abs(longitude["node/1002"] - 180.005) < 1e-9);
});

test("a viewport wholly in the next world copy is moved back to it (A3)", async () => {
  const { body } = await app.get(
    `${api}/features?key=amenity&bbox=180.1,-16.9,180.5,-16.8`,
  );
  assert.deepEqual(
    body.features.map(({ id }) => id),
    ["node/1003"],
  );
  assert.ok(Math.abs(body.features[0].geometry.coordinates[0] - 180.25) < 1e-9);
});

test("multi-key selections across 180 return each object once (A3)", async () => {
  const filters = JSON.stringify([
    { key: "amenity", values: [] },
    { key: "name", values: [] },
  ]);
  const { body } = await app.post(api + "/features", {
    filters,
    bbox: "179.9,-17,180.1,-16.9",
  });
  // The named road on each side also falls inside this viewport.
  assert.deepEqual(body.features.map(({ id }) => id).sort(), [
    "node/1001",
    "node/1002",
    "way/2001",
    "way/2002",
  ]);
});

test("nearby reaches across 180 with the true distance (A3)", async () => {
  for (const [lon, near, far] of [
    ["179.995", 179.995, 180.005],
    ["-179.995", -179.995, -180.005],
  ]) {
    const { body } = await app.get(
      `${api}/nearby?lat=-16.95&lon=${lon}&radius=1500`,
    );
    assert.equal(body.total, 2, lon);
    const [first, second] = body.features;
    assert.equal(first.properties.distance, 0);
    assert.ok(Math.abs(second.properties.distance - 1064) < 5);
    assert.ok(Math.abs(first.geometry.coordinates[0] - near) < 1e-9);
    assert.ok(Math.abs(second.geometry.coordinates[0] - far) < 1e-9);
  }
});

test("Luxembourg in the same server is unaffected", async () => {
  const { body } = await app.get(
    "/api/analytics/LU/features?key=highway&region=C02&bbox=5.9,49.5,6.3,49.8",
  );
  assert.deepEqual(ids({ body }), ["way/201"]);
});
