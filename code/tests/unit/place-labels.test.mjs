import assert from "node:assert/strict";
import test from "node:test";
import {
  labelWidth,
  rankPriority,
  visibleLabels,
} from "../../web/src/placeLabels.ts";

const box = (x, y, width = 60, height = 16) => ({ x, y, width, height });

test("labels that don't touch are all shown", () => {
  assert.deepEqual(visibleLabels([box(0, 0), box(200, 0), box(0, 200)]), [true, true, true]);
});

test("the more important label wins an overlap", () => {
  assert.deepEqual(visibleLabels([box(0, 0), box(30, 5)]), [true, false]);
});

test("a hidden label doesn't block the labels after it", () => {
  assert.deepEqual(visibleLabels([box(0, 0), box(50, 0), box(100, 0)]), [true, false, true]);
});

test("labels touching only across a grid cell edge still collide", () => {
  assert.deepEqual(visibleLabels([box(127, 10), box(129, 10)]), [true, false]);
  assert.deepEqual(visibleLabels([box(-1, -1), box(1, 1)]), [true, false]);
});

test("a wide label spanning several grid cells collides with one at its far end", () => {
  assert.deepEqual(visibleLabels([box(0, 0, 600), box(290, 0, 20)]), [true, false]);
});

test("cities come before towns, and towns before villages", () => {
  assert.ok(rankPriority("city") < rankPriority("town"));
  assert.ok(rankPriority("town") < rankPriority("village"));
});

test("longer names are wider", () => {
  assert.ok(labelWidth("Bad Radkersburg") > labelWidth("Wien"));
});

test("thousands of labels are handled quickly", () => {
  const many = Array.from({ length: 6300 }, (_, i) => box((i * 37) % 4000, (i * 91) % 3000));
  const started = performance.now();
  const shown = visibleLabels(many);
  assert.ok(performance.now() - started < 200);
  assert.ok(shown.filter(Boolean).length < many.length);
});
