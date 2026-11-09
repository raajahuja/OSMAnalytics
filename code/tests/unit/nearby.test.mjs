import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { distanceFrom, queryNearby } from "../../server/nearby.mjs";
import { encodeGeometry } from "../geometry-encode.mjs";

test("nearby lists mapped objects before abstract relations, then by distance and size", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE map_features (fid INTEGER PRIMARY KEY, kind TEXT, osm_id INTEGER, label TEXT, geometry BLOB);
    CREATE TABLE map_tags (key_id INTEGER, fid INTEGER, value_id INTEGER, PRIMARY KEY(key_id, fid)) WITHOUT ROWID;
    CREATE TABLE tag_key_names (id INTEGER PRIMARY KEY, key TEXT);
    CREATE TABLE tag_value_names (id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO tag_key_names VALUES (0, 'type');
    CREATE VIRTUAL TABLE map_bounds USING rtree(fid, west, east, south, north);
  `);
  const add = (fid, kind, geometry, bound, type) => {
    db.prepare("INSERT INTO map_features VALUES (?, ?, ?, NULL, ?)").run(
      fid,
      kind,
      fid,
      encodeGeometry(geometry),
    );
    db.prepare("INSERT INTO map_bounds VALUES (?, ?, ?, ?, ?)").run(
      fid,
      ...bound,
    );
    if (type) {
      db.prepare("INSERT OR IGNORE INTO tag_value_names(value) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM tag_value_names WHERE value=?)").run(type, type);
      db.prepare("INSERT INTO map_tags SELECT 0, ?, id FROM tag_value_names WHERE value=?").run(fid, type);
    }
  };
  const area = (fid, kind, size, type) =>
    add(
      fid,
      kind,
      {
        type: "Polygon",
        coordinates: [
          [
            [-size, -size],
            [size, -size],
            [size, size],
            [-size, size],
            [-size, -size],
          ],
        ],
      },
      [-size, size, -size, size],
      type,
    );
  area(1, "relation", 0.01, "boundary");
  area(2, "way", 0.005);
  area(3, "way", 0.001);
  add(4, "node", { type: "Point", coordinates: [0, 0.0005] }, [0, 0, 0.0005, 0.0005]);
  area(5, "relation", 0.002, "multipolygon");
  const { features } = queryNearby(
    db,
    new URLSearchParams({ lat: "0", lon: "0", radius: "100" }),
  );
  assert.deepEqual(
    features.map(({ id }) => id),
    ["way/3", "relation/5", "way/2", "node/4", "relation/1"],
  );
});

test("nearby search measures the nearest geometry, including polygon interiors and holes", () => {
  const distance = distanceFrom(0, 0);
  const square = (size) => [
    [-size, -size],
    [size, -size],
    [size, size],
    [-size, size],
    [-size, -size],
  ];
  const crossing = {
    type: "LineString",
    coordinates: [
      [-0.003, 0],
      [0.003, 0],
    ],
  };
  assert.ok(distance(crossing) < 1e-8);
  assert.equal(distance({ type: "Polygon", coordinates: [square(0.003)] }), 0);
  const holeDistance = distance({
    type: "Polygon",
    coordinates: [square(0.003), square(0.001)],
  });
  assert.ok(holeDistance > 110 && holeDistance < 112);
  const corner = { type: "Point", coordinates: [0.0008, 0.0008] };
  assert.ok(distance(corner) > 100);
  assert.ok(
    distance({ type: "GeometryCollection", geometries: [corner, crossing] }) <
      1e-8,
  );
});
