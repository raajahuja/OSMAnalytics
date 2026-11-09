// Writes the pipeline's binary geometry format, so tests can build database rows.
const CODES = { Point: 0, LineString: 1, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };

export function encodeGeometry(geometry) {
  const out = [CODES[geometry.type]];
  const varint = (input) => {
    let value = input;
    while (value >= 128) {
      out.push((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    out.push(value);
  };
  if (geometry.type === "GeometryCollection") {
    varint(geometry.geometries.length);
    for (const member of geometry.geometries) out.push(...encodeGeometry(member));
    return Uint8Array.from(out);
  }
  const { type, coordinates: c } = geometry;
  let points;
  if (type === "Point") points = [c];
  else if (type === "LineString" || type === "MultiPoint") {
    varint(c.length);
    points = c;
  } else if (type === "Polygon" || type === "MultiLineString") {
    varint(c.length);
    c.forEach((part) => varint(part.length));
    points = c.flat();
  } else {
    varint(c.length);
    for (const polygon of c) {
      varint(polygon.length);
      polygon.forEach((ring) => varint(ring.length));
    }
    points = c.flat(2);
  }
  let px = 0;
  let py = 0;
  const zigzag = (delta) => (delta < 0 ? -delta * 2 - 1 : delta * 2);
  for (const [lon, lat] of points) {
    const x = Math.round(lon * 1e7);
    const y = Math.round(lat * 1e7);
    varint(zigzag(x - px));
    varint(zigzag(y - py));
    px = x;
    py = y;
  }
  return Uint8Array.from(out);
}
