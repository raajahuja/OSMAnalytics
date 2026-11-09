import assert from "node:assert/strict";
import test from "node:test";
import { decodeGeometry } from "../../server/geometry.mjs";
import { encodeGeometry } from "../geometry-encode.mjs";

// Each hex string was produced by code/pipeline/geometry_codec.py.
const fromPython = {"point": {"hex": "0080b6ba3ac08491d903", "geo": {"type": "Point", "coordinates": [6.1296, 49.6116]}}, "negative": {"hex": "00fdc7ceb40dfffef5b103", "geo": {"type": "Point", "coordinates": [-179.9999999, -45.5]}}, "pastDateline": {"hex": "0080bdffed1a80dac409", "geo": {"type": "Point", "coordinates": [360.5, 1.0]}}, "line": {"hex": "010380dac40980b4891380ade204c096b102bf96b102c0c39307", "geo": {"type": "LineString", "coordinates": [[1.0, 2.0], [1.5, 2.25], [1.25, 3.0]]}}, "polygon": {"hex": "03020404000080e89226000080e89226ffe79226ffe7922680dac40980dac40980dac409000080dac409ffd9c409ffd9c409", "geo": {"type": "Polygon", "coordinates": [[[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 0.0]], [[1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 1.0]]]}}, "multiPoint": {"hex": "040280dac40980dac40980dac40980dac409", "geo": {"type": "MultiPoint", "coordinates": [[1.0, 1.0], [2.0, 2.0]]}}, "multiLine": {"hex": "0502020380dac40980dac40980dac40980dac40980dac40980dac40980dac40980dac40980dac40980dac409", "geo": {"type": "MultiLineString", "coordinates": [[[1.0, 1.0], [2.0, 2.0]], [[3.0, 3.0], [4.0, 4.0], [5.0, 5.0]]]}}, "multiPolygon": {"hex": "060201040104000080dac409000080dac409ffd9c409ffd9c40980c2d72f80c2d72f80dac409000080dac409ffd9c409ffd9c409", "geo": {"type": "MultiPolygon", "coordinates": [[[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]], [[[5.0, 5.0], [6.0, 5.0], [6.0, 6.0], [5.0, 5.0]]]]}}, "collection": {"hex": "07020080dac40980b489130102808ece1c80e8922680b4891380b48913", "geo": {"type": "GeometryCollection", "geometries": [{"type": "Point", "coordinates": [1.0, 2.0]}, {"type": "LineString", "coordinates": [[3.0, 4.0], [5.0, 6.0]]}]}}};

for (const [name, { hex, geo }] of Object.entries(fromPython))
  test("decodes what the pipeline wrote: " + name, () => {
    assert.deepEqual(decodeGeometry(Buffer.from(hex, "hex")), geo);
  });

for (const [name, { hex, geo }] of Object.entries(fromPython))
  test("the test encoder matches the pipeline: " + name, () => {
    assert.equal(Buffer.from(encodeGeometry(geo)).toString("hex"), hex);
  });
