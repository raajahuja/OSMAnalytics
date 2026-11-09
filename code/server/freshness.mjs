// How recently the objects in a selection were edited, measured from the snapshot.
const year = 31_557_600;
const staleYears = 3;
const gridCells = 40;
const minimumCellObjects = 5;
const listSize = 15;

function keepBest(list, item, isBetter) {
  if (list.length === listSize && !isBetter(item, list.at(-1))) return;
  const position = list.findIndex((other) => isBetter(item, other));
  list.splice(position < 0 ? list.length : position, 0, item);
  if (list.length > listSize) list.pop();
}

function gridFor([west, south, east, north]) {
  const cosine = Math.cos(((south + north) / 2) * (Math.PI / 180));
  const latitude = Math.max(north - south, (east - west) * cosine) / gridCells;
  return { west, south, east, north, latitude, longitude: latitude / cosine };
}

export function queryFreshness(db, dataset, area, scoped, everyRegion) {
  const parsed = Date.parse(dataset.snapshot) / 1000;
  const snapshot = Number.isFinite(parsed) ? parsed : Date.now() / 1000;
  const staleBefore = snapshot - staleYears * year;
  const recentAfter = snapshot - year;
  const grid = gridFor(area.bounds);
  const edits = [];
  const years = new Map();
  const cells = new Map();
  const mostEdited = [];
  const oldest = [];
  let stale = 0,
    recent = 0,
    versions = 0,
    maxVersion = 0;

  const rows = db
    .prepare(
      `WITH hits AS MATERIALIZED (${scoped.sql})
       SELECT a.fid, a.version, a.edited, a.lon, a.lat
       FROM hits CROSS JOIN feature_freshness a ON a.fid = hits.fid
       WHERE a.edited IS NOT NULL`,
    )
    .iterate(...scoped.parameters);
  for (const row of rows) {
    const isStale = row.edited < staleBefore;
    edits.push(row.edited);
    stale += isStale;
    recent += row.edited >= recentAfter;
    versions += row.version;
    maxVersion = Math.max(maxVersion, row.version);
    const editYear = new Date(row.edited * 1000).getUTCFullYear();
    years.set(editYear, (years.get(editYear) ?? 0) + 1);
    keepBest(
      mostEdited,
      row,
      (a, b) => a.version > b.version || (a.version === b.version && a.fid < b.fid),
    );
    keepBest(
      oldest,
      row,
      (a, b) => a.edited < b.edited || (a.edited === b.edited && a.fid < b.fid),
    );
    // Relations such as the EU have centres far outside the area.
    if (
      row.lon >= grid.west &&
      row.lon <= grid.east &&
      row.lat >= grid.south &&
      row.lat <= grid.north
    ) {
      const column = Math.floor((row.lon - grid.west) / grid.longitude);
      const line = Math.floor((row.lat - grid.south) / grid.latitude);
      const key = column * 100_000 + line;
      const cell = cells.get(key) ?? { column, line, objects: 0, stale: 0 };
      cell.objects += 1;
      cell.stale += isStale;
      cells.set(key, cell);
    }
  }

  const sorted = Float64Array.from(edits).sort();
  const describe = db.prepare(
    "SELECT kind, osm_id, label FROM map_features WHERE fid = ?",
  );
  const listed = ({ fid, version, edited }) => {
    const { kind, osm_id, label } = describe.get(fid);
    return { kind, id: osm_id, label, version, edited };
  };
  const firstYear = Math.min(...years.keys());
  const lastYear = Math.max(...years.keys());
  const regions = db
    .prepare(
      `WITH hits AS MATERIALIZED (${everyRegion.sql})
       SELECT r.region, COUNT(*) AS objects, SUM(a.edited < ?) AS stale,
              AVG(a.edited) AS average
       FROM hits
       CROSS JOIN feature_freshness a ON a.fid = hits.fid
       CROSS JOIN feature_regions r ON r.fid = hits.fid
       WHERE a.edited IS NOT NULL
       GROUP BY r.region`,
    )
    .all(...everyRegion.parameters, staleBefore)
    .map(({ region, objects, stale: old, average }) => ({
      id: dataset.areas[region + 1].id,
      name: dataset.areas[region + 1].name,
      objects,
      stale: old,
      averageAgeYears: (snapshot - average) / year,
    }))
    .sort((a, b) => b.stale / b.objects - a.stale / a.objects);

  return {
    snapshot: dataset.snapshot,
    staleYears,
    objects: edits.length,
    stale,
    recent,
    medianEdited: edits.length ? sorted[Math.floor(edits.length / 2)] : null,
    averageVersion: edits.length ? versions / edits.length : null,
    maxVersion,
    staleYear: new Date(staleBefore * 1000).getUTCFullYear(),
    years: edits.length
      ? Array.from({ length: lastYear - firstYear + 1 }, (_, index) => ({
          year: firstYear + index,
          objects: years.get(firstYear + index) ?? 0,
        }))
      : [],
    regions,
    cells: [...cells.values()]
      .filter(({ objects }) => objects >= minimumCellObjects)
      .map(({ column, line, objects, stale: old }) => ({
        bounds: [
          grid.west + column * grid.longitude,
          grid.south + line * grid.latitude,
          grid.west + (column + 1) * grid.longitude,
          grid.south + (line + 1) * grid.latitude,
        ],
        objects,
        stale: old,
      })),
    mostEdited: mostEdited.map(listed),
    oldest: oldest.map(listed),
  };
}
