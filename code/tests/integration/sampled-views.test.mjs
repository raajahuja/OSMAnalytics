// The sampled path only runs on large selections, so these tests force it on the
// fixture and require exactly the same answers as the normal query.
import assert from "node:assert/strict";
import test from "node:test";
import { buildFixture, startServer } from "../helpers.mjs";

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
