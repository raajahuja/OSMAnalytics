// Pins exact API output on the fixture. After an intended change, review the
// diff and refresh with: UPDATE_GOLDEN=1 npm run test:regression
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFixture, removeFixture, startServer } from "../helpers.mjs";

const golden = new URL("./golden/", import.meta.url);
const bbox = "5.9,49.5,6.3,49.8";
const filters = encodeURIComponent(
  JSON.stringify([
    { key: "highway", values: ["motorway", "residential"] },
    { key: "barrier", values: [] },
  ]),
);
const cases = {
  countries: "/api/analytics",
  dataset: "/api/analytics/LU",
  "tag-keys": "/api/analytics/LU/tags",
  "tag-values": "/api/analytics/LU/tags?key=highway&focus=motorway",
  "tag-options": "/api/analytics/LU/tags?key=name&view=options&sort=name",
  "tag-regions": "/api/analytics/LU/tag-regions?key=highway&focus=motorway",
  "map-context": "/api/analytics/LU/map",
  "features-multi": `/api/analytics/LU/features?bbox=${bbox}&filters=${filters}`,
  selection: `/api/analytics/LU/selection?filters=${filters}&match=all`,
  nearby: "/api/analytics/LU/nearby?lat=49.531&lon=5.931&radius=300",
  object: "/api/analytics/LU/object/relation/301",
};

let output, app;
before(async () => {
  output = buildFixture();
  app = await startServer({ output });
});
after(async () => {
  await app?.stop();
  if (output) removeFixture(output);
});

// Map projections differ in the last few digits from one platform to another.
const rounded = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "number" ? Number(item.toFixed(9)) : item,
    ),
  );

// Tied rows are ordered by hash, which is stable, so nothing needs masking.
for (const [name, pathname] of Object.entries(cases)) {
  test("golden response: " + name, async () => {
    const { status, body } = await app.get(pathname);
    assert.equal(status, 200);
    const file = new URL(name + ".json", golden);
    if (process.env.UPDATE_GOLDEN) {
      fs.mkdirSync(golden, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body, null, 1) + "\n");
      return;
    }
    assert.ok(
      fs.existsSync(file),
      "Missing golden file. Run UPDATE_GOLDEN=1 npm run test:regression",
    );
    assert.deepEqual(
      rounded(body),
      rounded(JSON.parse(fs.readFileSync(file, "utf8"))),
    );
  });
}
