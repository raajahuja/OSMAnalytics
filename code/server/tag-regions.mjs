// How one tag key, or some of its values, is spread across a country's regions.
export function tagRegions(db, dataset, { key, focus, kind, count, distinct }) {
  const keyStats = db.prepare(
    `SELECT ${count} AS objects, ${distinct} AS distinct_values
     FROM tag_keys WHERE region = ? AND key = ?`,
  );
  const selected = db.prepare(
    `SELECT SUM(${count}) AS objects FROM tag_values
     WHERE region = ? AND key = ? AND value IN (${focus.map(() => "?").join(",")})`,
  );
  const topValue = db.prepare(
    `SELECT value, ${count} AS objects FROM tag_values
     WHERE region = ? AND key = ? AND (${count}) > 0
     ORDER BY objects DESC, value LIMIT 1`,
  );
  const matching = (id) =>
    focus.length
      ? (selected.get(id, key, ...focus)?.objects ?? 0)
      : (keyStats.get(id, key)?.objects ?? 0);
  const objectsIn = ({ objects }) =>
    kind === "all"
      ? Object.values(objects).reduce((sum, amount) => sum + amount, 0)
      : (objects[kind] ?? 0);
  const regions = dataset.areas
    .slice(1)
    .map((area) => {
      const stats = keyStats.get(area.id, key);
      const top = topValue.get(area.id, key);
      return {
        id: area.id,
        name: area.name,
        areaKm2: area.area,
        count: matching(area.id),
        keyCount: stats?.objects ?? 0,
        distinctValues: stats?.distinct_values ?? 0,
        regionObjects: objectsIn(area),
        topValue: top?.value ?? null,
        topCount: top?.objects ?? 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { key, focus, total: matching("all"), regions };
}
