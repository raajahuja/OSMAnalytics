import assert from "node:assert/strict";
import test from "node:test";
import { snapBounds } from "../../web/src/api.ts";

test("nearby views snap to the same request", () => {
  const a = snapBounds([6.101, 49.601, 6.141, 49.631], 13);
  const b = snapBounds([6.103, 49.603, 6.143, 49.633], 13);
  assert.equal(a, b);
});

test("a snapped view always covers the real view", () => {
  const view = [16.3123, 48.1567, 16.4521, 48.2489];
  const [west, south, east, north] = snapBounds(view, 12).split(",").map(Number);
  assert.ok(west <= view[0] && south <= view[1] && east >= view[2] && north >= view[3]);
});

test("latitude stays on the globe", () => {
  const [, south, , north] = snapBounds([-180, -89.99, 180, 89.99], 1).split(",").map(Number);
  assert.equal(south, -90);
  assert.equal(north, 90);
});
