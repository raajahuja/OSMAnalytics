// The sampled path only runs on large selections, so these tests force it on the
// fixture and require exactly the same answers as the normal query.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFixture, removeFixture, startServer } from "../helpers.mjs";

const request = async (app, path) => {
  const response = await fetch(app.base + path);
  return { status: response.status, body: await response.text() };
};
const q = (values) => new URLSearchParams(values).toString();

test("sampled views give the same answers as the normal query", async () => {
  const output = buildFixture();
  const normal = await startServer({ output });
  process.env.WAYFINDER_SAMPLE_MIN_MATCHES = "1";
  let sampled;
  try {
    sampled = await startServer({ output });
  } finally {
    delete process.env.WAYFINDER_SAMPLE_MIN_MATCHES;
  }
  try {
    const dataset = JSON.parse((await request(normal, "/api/analytics/LU")).body);
    const region = dataset.areas[1].id;
    const [west, south, east, north] = dataset.areas[0].bounds;
    const keys = JSON.parse((await request(normal, "/api/analytics/LU/tags")).body).rows
      .slice(0, 3)
      .map((row) => row.key);
    const value = JSON.parse(
      (await request(normal, "/api/analytics/LU/tags?" + q({ key: keys[0] }))).body,
    ).rows[0].value;
    const rules = (...list) =>
      JSON.stringify(list.map((key) => ({ key, values: [] })));
    const views = {
      whole: [west - 1, south - 1, east + 1, north + 1],
      part: [west, south, (west + east) / 2, (south + north) / 2],
    };
    const selections = [
      { key: keys[0] },
      { key: keys[0], value },
      { filters: rules(keys[0], keys[1]) },
      { filters: rules(keys[0], keys[1]), match: "all" },
      { filters: rules(...keys) },
    ];
    const scopes = [{}, { region }, { kind: "way" }, { region, kind: "node" }];
    let compared = 0;
    for (const bbox of Object.values(views))
      for (const selection of selections)
        for (const scope of scopes) {
          const url =
            "/api/analytics/LU/features?" +
            q({ ...selection, ...scope, bbox: bbox.join(",") });
          const [expected, actual] = await Promise.all([
            request(normal, url),
            request(sampled, url),
          ]);
          assert.equal(expected.status, 200, url);
          assert.deepEqual(actual, expected, url);
          compared++;
        }
    assert.equal(compared, 40);
  } finally {
    await normal.stop();
    await sampled.stop();
  }
});

test("every object in sample order matches the sorted query", async () => {
  const { openForBuild, everythingSampleIds } = await import(
    "../../server/analytics.mjs"
  );
  const output = buildFixture();
  const { db, dataset } = openForBuild(output + "/analytics/LU.sqlite");
  try {
    const [w, s, e, n] = dataset.areas[0].bounds;
    const views = [
      [true, [w - 1, s - 1, e + 1, n + 1]],
      [false, [w, s, (w + e) / 2, n]],
    ];
    let compared = 0;
    for (const kind of ["all", "node", "way", "relation"])
      for (const areaIndex of [0, 1])
        for (const [wholeArea, [west, south, east, north]] of views) {
          const scope = { kind, areaIndex, rules: [], everything: true };
          const ids = everythingSampleIds(db, scope, {
            wholeArea,
            viewShare: 0.5,
            east,
            west,
            north,
            south,
          });
          const expected = db
            .prepare(
              "SELECT m.fid FROM map_bounds m JOIN map_features f ON f.fid=m.fid " +
                "WHERE m.west<=? AND m.east>=? AND m.south<=? AND m.north>=? " +
                "AND (?='all' OR f.kind=?) AND (?=0 OR EXISTS (SELECT 1 FROM " +
                "feature_regions r WHERE r.fid=m.fid AND r.region=?)) " +
                "ORDER BY ((m.fid * 2654435761) & 2147483647) LIMIT 1201",
            )
            .all(east, west, north, south, kind, kind, areaIndex, areaIndex - 1)
            .map(({ fid }) => fid);
          assert.deepEqual(ids, expected, `${kind} ${areaIndex} ${wholeArea}`);
          if (expected.length) compared++;
        }
    assert.ok(compared >= 8, String(compared));
  } finally {
    db.close();
    removeFixture(output);
  }
});
