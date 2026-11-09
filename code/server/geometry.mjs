// Decodes the binary geometry written by code/pipeline/geometry_codec.py.
const POINT = 0;
const LINESTRING = 1;
const POLYGON = 3;
const MULTIPOINT = 4;
const MULTILINESTRING = 5;
const MULTIPOLYGON = 6;
const COLLECTION = 7;
const SCALE = 1e7;

function decodeAt(bytes, start) {
  let offset = start;
  // Coordinates pass 32 bits, so this uses arithmetic rather than bit shifts.
  const varint = () => {
    let value = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[offset++];
      value += (byte & 127) * scale;
      scale *= 128;
    } while (byte >= 128);
    return value;
  };
  const kind = bytes[offset++];
  if (kind === COLLECTION) {
    const geometries = [];
    for (let count = varint(); count > 0; count--) {
      const member = decodeAt(bytes, offset);
      geometries.push(member.geometry);
      offset = member.offset;
    }
    return { geometry: { type: "GeometryCollection", geometries }, offset };
  }

  // The part sizes come first, so they are read before any coordinate.
  const sizes = (count = varint()) =>
    Array.from({ length: count }, () => varint());
  let layout;
  if (kind === LINESTRING || kind === MULTIPOINT) layout = varint();
  else if (kind === POLYGON || kind === MULTILINESTRING) layout = sizes();
  else if (kind === MULTIPOLYGON)
    layout = Array.from({ length: varint() }, () => sizes());

  let x = 0;
  let y = 0;
  const delta = () => {
    const value = varint();
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  const point = () => {
    x += delta();
    y += delta();
    return [x / SCALE, y / SCALE];
  };
  const path = (length) => Array.from({ length }, point);

  let geometry;
  if (kind === POINT) geometry = { type: "Point", coordinates: point() };
  else if (kind === LINESTRING)
    geometry = { type: "LineString", coordinates: path(layout) };
  else if (kind === MULTIPOINT)
    geometry = { type: "MultiPoint", coordinates: path(layout) };
  else if (kind === POLYGON)
    geometry = { type: "Polygon", coordinates: layout.map(path) };
  else if (kind === MULTILINESTRING)
    geometry = { type: "MultiLineString", coordinates: layout.map(path) };
  else if (kind === MULTIPOLYGON)
    geometry = {
      type: "MultiPolygon",
      coordinates: layout.map((rings) => rings.map(path)),
    };
  else throw Error("Unknown geometry type " + kind);
  return { geometry, offset };
}

export const decodeGeometry = (bytes) => decodeAt(bytes, 0).geometry;
