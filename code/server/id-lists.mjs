// Precomputed, sorted lists of the features carrying a common tag, so that
// combining filters is array work instead of grouping every matching row.
export const WHOLE_KEY = -1;
export const REGION_LISTS = -2;
export const KIND_LISTS = -3;
export const KIND_IDS = { node: 0, way: 1, relation: 2 };

const CACHE_BYTES = 128 * 1024 * 1024;
const caches = new WeakMap();

function cacheFor(db) {
  let cache = caches.get(db);
  if (!cache) {
    cache = {
      lists: new Map(),
      bytes: 0,
      read: db.prepare("SELECT ids FROM id_lists WHERE key_id=? AND value_id=?"),
      wholeKey: db.prepare("SELECT fid FROM map_tags WHERE key_id=? ORDER BY fid"),
      oneValue: db.prepare(
        "SELECT fid FROM map_tags WHERE key_id=? AND value_id=? ORDER BY fid",
      ),
    };
    caches.set(db, cache);
  }
  return cache;
}

function toIds(blob) {
  // A view needs 4-byte alignment, which a returned blob doesn't promise.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Uint32Array(copy.buffer);
}

export function idList(db, first, second) {
  const cache = cacheFor(db);
  const name = first + ":" + second;
  const held = cache.lists.get(name);
  if (held) {
    cache.lists.delete(name);
    cache.lists.set(name, held);
    return held;
  }
  const row = cache.read.get(first, second);
  let ids;
  if (row) ids = toIds(row.ids);
  else if (first < 0) ids = new Uint32Array();
  else {
    // Uncommon tags have no list, but they are quick to read directly.
    const rows =
      second === WHOLE_KEY
        ? cache.wholeKey.all(first)
        : cache.oneValue.all(first, second);
    ids = Uint32Array.from(rows, ({ fid }) => fid);
  }
  cache.lists.set(name, ids);
  cache.bytes += ids.byteLength;
  for (const [oldest, old] of cache.lists) {
    if (cache.bytes <= CACHE_BYTES || oldest === name) break;
    cache.lists.delete(oldest);
    cache.bytes -= old.byteLength;
  }
  return ids;
}

export function union(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const merged = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let size = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    merged[size++] = x < y ? x : y;
    if (x <= y) i++;
    if (y <= x) j++;
  }
  while (i < a.length) merged[size++] = a[i++];
  while (j < b.length) merged[size++] = b[j++];
  return merged.subarray(0, size);
}

export function intersect(first, second) {
  const [small, large] =
    first.length <= second.length ? [first, second] : [second, first];
  const found = new Uint32Array(small.length);
  let size = 0;
  let low = 0;
  for (let index = 0; index < small.length; index++) {
    const target = small[index];
    // Doubling steps skip quickly over a much longer list.
    let step = 1;
    let high = low;
    while (high < large.length && large[high] < target) {
      low = high + 1;
      high += step;
      step *= 2;
    }
    high = Math.min(high, large.length);
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (large[middle] < target) low = middle + 1;
      else high = middle;
    }
    if (low < large.length && large[low] === target) found[size++] = target;
  }
  return found.subarray(0, size);
}

function ruleIds(db, { keyId, valueIds }) {
  if (keyId < 0) return new Uint32Array();
  if (!valueIds.length) return idList(db, keyId, WHOLE_KEY);
  return valueIds
    .filter((id) => id >= 0)
    .map((id) => idList(db, keyId, id))
    .reduce(union, new Uint32Array());
}

export function matchingIds(db, rules, { matchAll, kind, regionIndex }) {
  let ids = rules
    .map((rule) => ruleIds(db, rule))
    .reduce((combined, list, index) =>
      index ? (matchAll ? intersect : union)(combined, list) : list,
    );
  if (kind !== "all") ids = intersect(ids, idList(db, KIND_LISTS, KIND_IDS[kind]));
  if (regionIndex >= 0) ids = intersect(ids, idList(db, REGION_LISTS, regionIndex));
  return ids;
}
