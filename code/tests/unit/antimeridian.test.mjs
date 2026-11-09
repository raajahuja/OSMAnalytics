import test from "node:test";
import assert from "node:assert/strict";
import {
  longitudeRanges,
  shiftGeometry,
  viewportBoxes,
} from "../../server/antimeridian.mjs";

const box = (west, east, offset) => ({
  west,
  south: 2,
  east,
  north: 4,
  offset,
});

test("an ordinary viewport stays one unchanged box", () => {
  assert.deepEqual(viewportBoxes([6.1248, 2, 6.138, 4]), [
    box(6.1248, 6.138, 0),
  ]);
  assert.deepEqual(viewportBoxes([-180, 2, 180, 4]), [box(-180, 180, 0)]);
});

test("a viewport crossing 180 splits and moves its eastern half back", () => {
  assert.deepEqual(viewportBoxes([179, 2, 181, 4]), [
    box(179, 180, 0),
    box(-180, -179, 360),
  ]);
});

test("a viewport crossing -180 splits the same way", () => {
  assert.deepEqual(viewportBoxes([-181, 2, -179, 4]), [
    box(179, 180, -360),
    box(-180, -179, 0),
  ]);
});

test("a viewport wholly in the next world copy maps back with an offset", () => {
  assert.deepEqual(viewportBoxes([185, 2, 190, 4]), [box(-175, -170, 360)]);
  assert.deepEqual(viewportBoxes([-190, 2, -185, 4]), [box(170, 175, -360)]);
  assert.deepEqual(viewportBoxes([725, 2, 730, 4]), [box(5, 10, 720)]);
});

test("a viewport wider than the world becomes one whole-world box", () => {
  assert.deepEqual(viewportBoxes([-200, 2, 200, 4]), [box(-180, 180, 0)]);
});

test("longitude ranges split only when they cross the line", () => {
  assert.deepEqual(longitudeRanges(5, 6), [[5, 6]]);
  assert.deepEqual(longitudeRanges(179, 181), [
    [179, 180],
    [-180, -179],
  ]);
  assert.deepEqual(longitudeRanges(-181, -179), [
    [179, 180],
    [-180, -179],
  ]);
  assert.deepEqual(longitudeRanges(-200, 200), [[-180, 180]]);
});

test("shifting moves longitude only, at every nesting level", () => {
  assert.deepEqual(
    shiftGeometry({ type: "Point", coordinates: [-179, 5] }, 360),
    { type: "Point", coordinates: [181, 5] },
  );
  assert.deepEqual(
    shiftGeometry(
      {
        type: "Polygon",
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      },
      -360,
    ).coordinates,
    [
      [
        [-359, 2],
        [-357, 4],
      ],
    ],
  );
  assert.deepEqual(
    shiftGeometry(
      {
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [0, 0] }],
      },
      360,
    ).geometries[0].coordinates,
    [360, 0],
  );
});

test("a zero offset returns the same object", () => {
  const geometry = { type: "Point", coordinates: [1, 2] };
  assert.equal(shiftGeometry(geometry, 0), geometry);
});
