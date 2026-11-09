import test, { before, after } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const base = "http://127.0.0.1:5187";
let app,
  logs = "";
before(async () => {
  app = spawn(process.execPath, ["code/server/index.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "5187",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (b) => (logs += b));
  app.stderr.on("data", (b) => (logs += b));
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw Error(logs);
    try {
      if ((await fetch(`${base}/api/analytics`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Test server startup timed out: ${logs}`);
});
after(async () => {
  if (app && app.exitCode === null) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    await exited;
  }
});
const get = async (path) => {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
};
test("localhost opens the analytics-only app without routing endpoints", async () => {
  for (const pathname of ["/", "/analytics", "/?source=overture"]) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OpenStreetMap Analytics/);
  }
  const stylesheet = await fetch(base + "/static/css/geostack-charcoal.css");
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /GeoStack Charcoal/);
  assert.equal((await get("/api/route")).status, 404);
  assert.equal((await get("/api/datasets")).status, 404);
});

test(
  "nearby queries return local objects by distance and paginate all results",
  {
    skip: !fs.existsSync(
      new URL("../../../output/analytics/LU.sqlite", import.meta.url),
    ),
  },
  async () => {
    const nearBusStop = await get(
      "/api/analytics/LU/nearby?lat=49.673300&lon=6.008710&radius=50",
    );
    assert.equal(nearBusStop.status, 200);
    assert.ok(
      nearBusStop.body.features.some(
        ({ id, properties }) =>
          id === "node/4171767660" &&
          properties.distance === 0 &&
          properties.category === "highway=bus_stop",
      ),
    );
    assert.ok(
      nearBusStop.body.features.every(
        ({ properties }) => properties.distance <= 50,
      ),
    );
    const city = "/api/analytics/LU/nearby?lat=49.611&lon=6.131&radius=250";
    const { body: first } = await get(city);
    const { body: second } = await get(city + "&page=2");
    assert.ok(first.total > first.pageSize);
    assert.equal(second.total, first.total);
    assert.equal(second.page, 2);
    const items = [...first.features, ...second.features];
    assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
    // Nodes and ways always rank as visible, so distance orders them.
    const mapped = items.filter(({ properties }) => properties.kind !== "relation");
    assert.ok(
      mapped.every(
        ({ properties }, i) =>
          i === 0 || properties.distance >= mapped[i - 1].properties.distance,
      ),
    );
    assert.equal(
      (await get("/api/analytics/LU/nearby?lat=49.611&lon=6.131&radius=2001"))
        .status,
      400,
    );
  },
);

test(
  "feature details show tags beyond the active map filter",
  {
    skip: !fs.existsSync(
      new URL("../../../output/analytics/LU.sqlite", import.meta.url),
    ),
  },
  async () => {
    const { status, body } = await get(
      "/api/analytics/LU/object/node/4171767660",
    );
    assert.equal(status, 200);
    assert.equal(body.label, "Nospelt, Pompjeesbau");
    assert.equal(body.geometry, "Point");
    assert.ok(body.coordinates.every(Number.isFinite));
    assert.ok(body.regions.includes("Capellen"));
    const tags = Object.fromEntries(
      body.tags.map(({ key, value }) => [key, value]),
    );
    assert.equal(tags.highway, "bus_stop");
    assert.equal(tags.public_transport, "platform");
    assert.ok("shelter" in tags && "bench" in tags);
    assert.equal((await get("/api/analytics/LU/object/way/1")).status, 404);
  },
);

test(
  "Luxembourg feature map serves real geometry with exact tag, canton, and viewport filters",
  {
    skip: !fs.existsSync(
      new URL("../../../output/analytics/LU.sqlite", import.meta.url),
    ),
  },
  async () => {
    const { body: data } = await get("/api/analytics/LU");
    const vianden = data.areas.find((area) => area.name === "Vianden");
    const query = (endpoint, params) =>
      get("/api/analytics/LU/" + endpoint + "?" + new URLSearchParams(params));
    const { body: gates } = await query("features", {
      key: "barrier",
      value: "gate",
      kind: "node",
      region: vianden.id,
      bbox: vianden.bounds.join(","),
    });
    const { body: counts } = await query("tags", {
      key: "barrier",
      focus: "gate",
      kind: "node",
      region: vianden.id,
    });
    assert.ok(gates.features.length > 0);
    assert.equal(gates.features.length, counts.comparison[vianden.id]);
    assert.ok(
      gates.features.every(
        ({ geometry, properties }) =>
          geometry.type === "Point" &&
          properties.kind === "node" &&
          properties.value === "gate",
      ),
    );

    const { body: roads } = await query("features", {
      key: "highway",
      value: "motorway",
      kind: "way",
      bbox: data.areas[0].bounds.join(","),
    });
    assert.ok(roads.features.length > 0);
    assert.ok(
      roads.features.every((feature) => feature.geometry.type === "LineString"),
    );
    const city = "6.1248,49.604,6.138,49.615";
    const { body: buildings } = await query("features", {
      key: "building",
      kind: "way",
      bbox: city,
    });
    assert.ok(
      buildings.features.some((feature) => feature.geometry.type === "Polygon"),
    );
    const { body: distant } = await query("features", {
      key: "building",
      bbox: "0,0,1,1",
    });
    assert.deepEqual(distant.features, []);
    assert.equal(
      (await query("features", { key: "building", bbox: "6,49" })).status,
      400,
    );
  },
);

test(
  "Luxembourg multi-select counts distinct objects and reports canton availability",
  {
    skip: !fs.existsSync(
      new URL("../../../output/analytics/LU.sqlite", import.meta.url),
    ),
  },
  async () => {
    const { body: data } = await get("/api/analytics/LU");
    const vianden = data.areas.find((area) => area.name === "Vianden");
    const query = async (endpoint, filters, match = "any") => {
      const result = await fetch(base + "/api/analytics/LU/" + endpoint, {
        method: "POST",
        body: new URLSearchParams({
          region: vianden.id,
          kind: "node",
          bbox: vianden.bounds.join(","),
          filters: JSON.stringify(filters),
          match,
        }),
      });
      assert.equal(result.status, 200);
      return result.json();
    };
    const barrier = { key: "barrier", values: ["gate", "lift_gate"] };
    const access = { key: "access", values: [] };
    const gates = await query("features", [barrier]);
    const accessPoints = await query("features", [access]);
    const any = await query("features", [barrier, access]);
    const all = await query("features", [barrier, access], "all");
    const counts = await query("selection", [barrier, access]);
    const both = await query("selection", [barrier, access], "all");
    const expected = new Set(
      [...gates.features, ...accessPoints.features].map(({ id }) => id),
    );
    assert.deepEqual(new Set(any.features.map(({ id }) => id)), expected);
    assert.equal(any.features.length, expected.size);
    assert.equal(counts.matchCount, expected.size);
    assert.equal(all.features.length, both.matchCount);
    assert.ok(
      all.features.length > 0 && all.features.length < any.features.length,
    );
    assert.ok(
      all.features.every(({ properties }) => properties.tags.length === 2),
    );
    const unavailable = await query("selection", [
      { key: "aeroway", values: [] },
      { key: "highway", values: ["motorway"] },
    ]);
    assert.ok(
      unavailable.keys.some(
        ([key, amount]) => key === "aeroway" && amount === 0,
      ),
    );
    assert.deepEqual(unavailable.values, [["highway", "motorway", 0]]);
  },
);

test(
  "Luxembourg analytics exposes every indexed tag and respects geography and object filters",
  {
    skip: !fs.existsSync(
      new URL("../../../output/analytics/LU.sqlite", import.meta.url),
    ),
  },
  async () => {
    const { body: countries } = await get("/api/analytics");
    assert.ok(countries.some((country) => country.id === "LU"));
    const { body: data } = await get("/api/analytics/LU");
    assert.equal(data.areas.length, 13);
    assert.equal(data.areas[0].id, "all");
    assert.ok(data.areas[0].keys > 3000);
    const region = data.areas.find((area) => area.name === "Vianden");
    const { body: keys } = await get("/api/analytics/LU/tags");
    assert.equal(keys.total, data.areas[0].keys);
    const { body: values } = await get(
      "/api/analytics/LU/tags?key=highway&kind=way&region=" +
        region.id +
        "&focus=residential",
    );
    assert.ok(values.tag.count > 0);
    assert.ok(values.rows.every((row) => row.count === row.ways && row.way_id));
    assert.equal(
      values.comparison[region.id],
      values.rows.find((row) => row.value === "residential").count,
    );
    assert.ok(values.comparison.all > values.comparison[region.id]);
    assert.deepEqual(
      values.distribution.top,
      values.rows.slice(0, 8).map(({ value, count }) => ({ value, count })),
    );
    assert.equal(
      values.distribution.top.reduce((sum, row) => sum + row.count, 0) +
        values.distribution.otherCount,
      values.tag.count,
    );

    const { body: names } = await get(
      "/api/analytics/LU/tags?key=name&kind=way&sort=name&page=2",
    );
    const { body: filteredNames } = await get(
      "/api/analytics/LU/tags?key=name&kind=way&q=xyz-no-matching-name-xyz",
    );
    assert.equal(names.page, 2);
    assert.equal(filteredNames.total, 0);
    assert.deepEqual(filteredNames.distribution, names.distribution);
    assert.ok(names.distribution.otherCount > 0);
    assert.equal(
      names.distribution.top.length + names.distribution.otherValues,
      names.tag.distinct_values,
    );

    const { body: restrictions } = await get(
      "/api/analytics/LU/tags?key=restriction&kind=relation",
    );
    assert.ok(restrictions.rows.some((row) => row.relation_id));
    const csv = await fetch(
      base + "/api/analytics/LU/tags?key=name&kind=way&format=csv",
    );
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /^text\/csv/);
    const exported = await csv.text();
    assert.match(
      exported,
      /^country,region_code,region,snapshot_utc,object_type,key,value,count,/,
    );
    assert.ok(exported.split("\n").length > 30);
    assert.equal(
      (await get("/api/analytics/LU/tags?region=missing")).status,
      400,
    );
  },
);
