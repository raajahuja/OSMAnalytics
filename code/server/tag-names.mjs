// Tags are stored as integer IDs. These turn names into IDs and back.
const dictionaries = new WeakMap();

function dictionary(db) {
  let names = dictionaries.get(db);
  if (!names) {
    const rows = db.prepare("SELECT id, key FROM tag_key_names").all();
    names = {
      keyIds: new Map(rows.map(({ id, key }) => [key, id])),
      keys: new Map(rows.map(({ id, key }) => [id, key])),
      valueId: db.prepare("SELECT id FROM tag_value_names WHERE value = ?"),
    };
    dictionaries.set(db, names);
  }
  return names;
}

// -1 is never an ID, so a name that isn't in this country matches nothing.
export const keyId = (db, key) => dictionary(db).keyIds.get(key) ?? -1;
export const keyName = (db, id) => dictionary(db).keys.get(id);
export const valueId = (db, value) =>
  dictionary(db).valueId.get(value)?.id ?? -1;

export function valueNames(db, ids) {
  if (!ids.size) return new Map();
  const rows = db
    .prepare(
      "SELECT id, value FROM tag_value_names WHERE id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify([...ids]));
  return new Map(rows.map(({ id, value }) => [id, value]));
}

export function resolveRule(db, { key, values }) {
  return {
    key,
    values,
    keyId: keyId(db, key),
    valueIds: values.map((value) => valueId(db, value)),
  };
}
