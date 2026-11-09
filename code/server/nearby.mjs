import { longitudeRanges, shiftGeometry } from "./antimeridian.mjs";
import { decodeGeometry } from "./geometry.mjs";
import { keyId, valueId } from "./tag-names.mjs";

const earth = 6_371_008.8;
const radians = Math.PI / 180;
const pageSize = 80;

function segmentDistanceSquared([ax, ay], [bx, by]) {
  const dx = bx - ax,
    dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length))
    : 0;
  return (ax + t * dx) ** 2 + (ay + t * dy) ** 2;
}

function pathDistance(project, points, ring = false) {
  if (!points.length) return { inside: false, distance: Infinity };
  let previous = project(points[ring ? points.length - 1 : 0]);
  let distance = previous[0] ** 2 + previous[1] ** 2;
  let inside = false;
  for (let i = ring ? 0 : 1; i < points.length; i++) {
    const next = project(points[i]);
    distance = Math.min(distance, segmentDistanceSquared(previous, next));
    if (ring) {
      const [ax, ay] = previous,
        [bx, by] = next;
      if (ay > 0 !== by > 0 && ax - ((bx - ax) * ay) / (by - ay) > 0)
        inside = !inside;
    }
    previous = next;
  }
  return { distance, inside };
}

export function distanceFrom(lat, lon) {
  const sinLat = Math.sin(lat * radians),
    cosLat = Math.cos(lat * radians);
  // Azimuthal equidistant projection centred on the query: radial distances are in metres.
  const project = ([lng, latitude]) => {
    const angle = latitude * radians;
    const delta = (lng - lon) * radians;
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const x = cos * Math.sin(delta);
    const y = cosLat * sin - sinLat * cos * Math.cos(delta);
    const h = Math.hypot(x, y);
    if (!h) return [0, 0];
    const scale =
      (earth * Math.atan2(h, sinLat * sin + cosLat * cos * Math.cos(delta))) /
      h;
    return [x * scale, y * scale];
  };
  const point = (coordinate) => {
    const [x, y] = project(coordinate);
    return x * x + y * y;
  };
  const polygon = ([outer, ...holes]) => {
    if (!outer) return Infinity;
    const shell = pathDistance(project, outer, true);
    let insideHole = false,
      distance = shell.distance;
    for (const ring of holes) {
      const hole = pathDistance(project, ring, true);
      insideHole ||= hole.inside;
      distance = Math.min(distance, hole.distance);
    }
    return shell.inside && !insideHole ? 0 : distance;
  };
  const minimum = (items, fn) =>
    items.reduce((best, item) => Math.min(best, fn(item)), Infinity);
  const squared = (geometry) => {
    const coordinates = geometry.coordinates;
    switch (geometry.type) {
      case "Point":
        return point(coordinates);
      case "MultiPoint":
        return minimum(coordinates, point);
      case "LineString":
        return pathDistance(project, coordinates).distance;
      case "MultiLineString":
        return minimum(
          coordinates,
          (line) => pathDistance(project, line).distance,
        );
      case "Polygon":
        return polygon(coordinates);
      case "MultiPolygon":
        return minimum(coordinates, polygon);
      case "GeometryCollection":
        return minimum(geometry.geometries, squared);
      default:
        return Infinity;
    }
  };
  return (geometry) => Math.sqrt(squared(geometry));
}

export function queryNearby(db, params) {
  const lat = Number(params.get("lat") ?? NaN);
  const lon = Number(params.get("lon") ?? NaN);
  const radius = Number(params.get("radius") ?? NaN);
  const requestedPage = Number(params.get("page") ?? 1);
  if (
    !params.get("lat")?.trim() ||
    !params.get("lon")?.trim() ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 85 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180 ||
    !Number.isInteger(radius) ||
    radius < 25 ||
    radius > 2000 ||
    !Number.isSafeInteger(requestedPage) ||
    requestedPage < 1
  )
    return null;
  const arc = radius / earth;
  const latSpan = arc / radians;
  const lonSpan = Math.asin(Math.sin(arc) / Math.cos(lat * radians)) / radians;
  const candidates = db.prepare(`
    SELECT f.fid, f.geometry, b.west, b.east, b.south, b.north,
      f.kind <> 'relation' OR EXISTS (
        SELECT 1 FROM map_tags t
        WHERE t.key_id = ? AND t.fid = f.fid
          AND t.value_id IN (?, ?)
      ) AS visible
    FROM map_bounds b CROSS JOIN map_features f ON f.fid = b.fid
    WHERE b.west <= ? AND b.east >= ? AND b.south <= ? AND b.north >= ?`);
  const typeKey = keyId(db, "type");
  const multipolygon = valueId(db, "multipolygon");
  const waterway = valueId(db, "waterway");
  const distance = distanceFrom(lat, lon);
  const matches = [];
  const seen = new Set();
  for (const [west, east] of longitudeRanges(lon - lonSpan, lon + lonSpan)) {
    for (const row of candidates.iterate(
      typeKey,
      multipolygon,
      waterway,
      east,
      west,
      lat + latSpan,
      lat - latSpan,
    )) {
      if (seen.has(row.fid)) continue;
      seen.add(row.fid);
      const metres = distance(decodeGeometry(row.geometry));
      if (metres <= radius)
        matches.push({
          fid: row.fid,
          metres,
          visible: row.visible,
          size: (row.east - row.west) * (row.north - row.south),
          longitude: (row.west + row.east) / 2,
        });
    }
  }
  // Mapped objects come before abstract relations such as boundaries and
  // treaties. Ties at 0 m are enclosing areas, so the most local one leads.
  matches.sort(
    (a, b) =>
      b.visible - a.visible ||
      a.metres - b.metres ||
      a.size - b.size ||
      a.fid - b.fid,
  );
  const page = Math.min(
    requestedPage,
    Math.max(1, Math.ceil(matches.length / pageSize)),
  );
  const feature = db.prepare(
    "SELECT kind, osm_id, label, geometry FROM map_features WHERE fid = ?",
  );
  const categoryKeys = "highway building amenity waterway natural barrier landuse leisure tourism shop railway place type water man_made power"
    .split(" ")
    .map((key) => keyId(db, key));
  const category = db.prepare(`
    SELECT k.key, v.value FROM map_tags t
    CROSS JOIN tag_key_names k ON k.id = t.key_id
    CROSS JOIN tag_value_names v ON v.id = t.value_id
    WHERE t.fid = ? AND t.key_id IN (${categoryKeys.join(",")})
    ORDER BY CASE k.key WHEN 'amenity' THEN 0 WHEN 'highway' THEN 1 WHEN 'type' THEN 3 ELSE 2 END, k.key
    LIMIT 1`);
  return {
    type: "FeatureCollection",
    total: matches.length,
    page,
    pageSize,
    features: matches
      .slice((page - 1) * pageSize, page * pageSize)
      .map(({ fid, metres, longitude }) => {
        const row = feature.get(fid);
        const tag = category.get(fid);
        // Across the antimeridian, draw the result on the same side as the query.
        const offset =
          Math.abs(longitude - lon) > 180
            ? Math.sign(lon - longitude) * 360
            : 0;
        return {
          type: "Feature",
          id: row.kind + "/" + row.osm_id,
          geometry: shiftGeometry(decodeGeometry(row.geometry), offset),
          properties: {
            kind: row.kind,
            id: row.osm_id,
            label: row.label,
            tags: [],
            category: tag ? tag.key + "=" + tag.value : null,
            distance: Math.round(metres),
          },
        };
      }),
  };
}
