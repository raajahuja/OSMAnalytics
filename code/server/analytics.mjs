import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateSync } from "node:zlib";
import { serveImagery } from "./imagery.mjs";
import { queryNearby } from "./nearby.mjs";
import { shiftGeometry, viewportBoxes } from "./antimeridian.mjs";
import { queryFreshness } from "./freshness.mjs";
import { decodeGeometry } from "./geometry.mjs";
import { matchingIds } from "./id-lists.mjs";
import { keyName, resolveRule, valueNames } from "./tag-names.mjs";
import { tagRegions } from "./tag-regions.mjs";

const objectCounts = {
  all: "nodes + ways + relations",
  node: "nodes",
  way: "ways",
  relation: "relations",
};
const valueCounts = {
  all: "values_all",
  node: "values_node",
  way: "values_way",
  relation: "values_relation",
};
const pageSize = 30;
const chartSize = 8;
const featureLimit = 1200;
const database = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  // SQLite's lower() only folds ASCII, which breaks search in most scripts.
  db.function("unicode_lower", { deterministic: true }, (text) =>
    typeof text === "string" ? text.toLowerCase() : text,
  );
  return db;
};
const summary = (db) =>
  JSON.parse(db.prepare("SELECT summary FROM metadata").get().summary);

// Connections stay open between requests, which keeps SQLite's memory-mapped
// pages and the parsed metadata. A rebuilt database is a new file, so it's
// picked up by the file check below.
const openCountries = new Map();
// Bump when a response changes shape without the database changing.
const API_VERSION = 1;
const SCHEMA = 2;
const CACHE_FOREVER = "public, max-age=31536000, immutable";
const CACHE_BRIEFLY = "public, max-age=60";


function openCountry(file) {
  const { ino, mtimeMs, size } = statSync(file);
  const identity = ino + ":" + mtimeMs + ":" + size;
  const open = openCountries.get(file);
  if (open?.identity === identity) return open;
  open?.db.close();
  const db = database(file);
  if (summary(db).schema !== SCHEMA) {
    db.close();
    throw Object.assign(new Error("Outdated database format."), {
      outdatedDatabase: true,
    });
  }
  db.exec("PRAGMA mmap_size=2147418112");
  const dataset = summary(db);
  // The same on every server holding this database, so CDN entries are shared.
  dataset.version = createHash("sha1")
    .update([dataset.snapshot, dataset.schema ?? 0, API_VERSION].join("|"))
    .digest("hex")
    .slice(0, 12);
  const country = { identity, db, dataset };
  openCountries.set(file, country);
  return country;
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // res.cacheControl is set once the request's dataset version is known.
    "Cache-Control": (status === 200 && res.cacheControl) || "no-store",
  });
  res.end(JSON.stringify(data));
}

export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  const safe =
    /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)
      ? "'" + value
      : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

async function exportRows(res, statement, parameters, values, scope) {
  const columns = values
    ? [
        "value",
        "count",
        "nodes",
        "ways",
        "relations",
        "node_id",
        "way_id",
        "relation_id",
      ]
    : ["key", "count", "distinct_values", "nodes", "ways", "relations"];
  const context = [
    "country",
    "region_code",
    "region",
    "snapshot_utc",
    "object_type",
  ];
  function* lines() {
    yield [...context, ...(values ? ["key"] : []), ...columns].join(",") +
      "\r\n";
    for (const row of statement.iterate(...parameters)) {
      yield [...scope, ...columns.map((column) => row[column])]
        .map(csvCell)
        .join(",") + "\r\n";
    }
  }
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="osm-tags.csv"',
    "Cache-Control": "no-store",
  });
  try {
    await pipeline(Readable.from(lines()), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
}

// Used at build time, where there are no request parameters to read.
export function openForBuild(file) {
  const db = database(file);
  return { db, dataset: summary(db) };
}

export function buildScope(db, areaIndex, kind, key, value) {
  return {
    kind,
    region: "",
    areaIndex,
    rules:
      key === null
        ? []
        : [resolveRule(db, { key, values: value === null ? [] : [value] })],
    all: false,
    everything: key === null,
  };
}

// Outlines and roads now come from the vector tiles. Place names are kept
// here because the location search needs the whole list at once.
function mapPlaces(db) {
  const document = JSON.parse(
    db.prepare("SELECT document FROM map_context").get().document,
  );
  return {
    type: "FeatureCollection",
    features: document.features.filter(
      ({ properties }) => properties.layer === "place",
    ),
  };
}

export function viewport(params) {
  const parts = params.get("bbox")?.split(",") ?? [];
  const bounds = parts.map(Number);
  const [west, south, east, north] = bounds;
  if (
    parts.length !== 4 ||
    parts.some((part) => !part.trim() || !Number.isFinite(Number(part))) ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  )
    return null;
  return bounds;
}

const placeholders = (values) => values.map(() => "?").join(",");

export function readRules(params) {
  const packed = params.get("filters");
  if (packed === null) {
    const key = params.get("key");
    const value = params.get("value");
    return key === null
      ? null
      : [{ key, values: value === null ? [] : [value] }];
  }
  try {
    const rules = JSON.parse(packed);
    if (
      !Array.isArray(rules) ||
      rules.length > 12 ||
      rules.some(
        (rule) =>
          !rule ||
          typeof rule.key !== "string" ||
          rule.key.length > 255 ||
          !Array.isArray(rule.values) ||
          rule.values.some((value) => typeof value !== "string"),
      ) ||
      new Set(rules.map(({ key }) => key)).size !== rules.length ||
      rules.reduce((size, { values }) => size + values.length, 0) > 40
    )
      return null;
    return rules.map(({ key, values }) => ({
      key,
      values: [...new Set(values)],
    }));
  } catch {
    return null;
  }
}

function mapScope(db, dataset, params) {
  const kind = params.get("kind") || "all";
  const region = params.get("region") || "all";
  const areaIndex = dataset.areas.findIndex((area) => area.id === region);
  const rules = readRules(params);
  if (!rules || !Object.hasOwn(objectCounts, kind) || areaIndex < 0)
    return null;
  return {
    kind,
    region,
    areaIndex,
    rules: rules.map((rule) => resolveRule(db, rule)),
    all: params.get("match") === "all",
    // Every object, whatever its tags. Too many keys to list as rules.
    everything: params.get("allKeys") === "1" && !rules.length,
  };
}

// SQL limiting a query to the selected object type and region. A feature row
// holds its whole geometry, so it's only read when the type is actually needed.
function scopeFilter(scope, fid, everyRegion = false) {
  const clauses = [],
    parameters = [];
  if (scope.kind !== "all") {
    clauses.push("f.kind=?");
    parameters.push(scope.kind);
  }
  if (!everyRegion && scope.areaIndex > 0) {
    clauses.push(
      "EXISTS (SELECT 1 FROM feature_regions r WHERE r.fid=" +
        fid +
        " AND r.region=?)",
    );
    parameters.push(scope.areaIndex - 1);
  }
  return {
    join: scope.kind !== "all" ? " CROSS JOIN map_features f ON f.fid=" + fid : "",
    clauses,
    parameters,
  };
}

export function tagConditions(rules) {
  const parameters = [];
  const condition = rules
    .map(({ keyId, valueIds }) => {
      parameters.push(keyId, ...valueIds);
      return (
        "(t.key_id=?" +
        (valueIds.length
          ? " AND t.value_id IN (" + placeholders(valueIds) + ")"
          : "") +
        ")"
      );
    })
    .join(" OR ");
  return { clause: "(" + condition + ")", parameters };
}

function tagCount(db, scope, rule) {
  const { key, values } = rule;
  return (
    db
      .prepare(
        "SELECT SUM(" +
          objectCounts[scope.kind] +
          ") AS count FROM " +
          (values.length ? "tag_values" : "tag_keys") +
          " WHERE region=? AND key=?" +
          (values.length ? " AND value IN (" + placeholders(values) + ")" : ""),
      )
      .get(scope.region, key, ...values).count ?? 0
  );
}

// SQL for the distinct objects a selection matches. No tag rules means all objects.
function matchedObjects(scope, everyRegion = false) {
  if (!scope.rules.length) {
    const filter = scopeFilter(scope, "f.fid", everyRegion);
    return {
      sql:
        "SELECT f.fid FROM map_features f" +
        (filter.clauses.length ? " WHERE " + filter.clauses.join(" AND ") : ""),
      parameters: filter.parameters,
    };
  }
  const filter = scopeFilter(scope, "t.fid", everyRegion);
  const tags = tagConditions(scope.rules);
  const multiple = scope.rules.length > 1;
  return {
    sql:
      "SELECT t.fid FROM map_tags t" +
      filter.join +
      " WHERE " +
      [tags.clause, ...filter.clauses].join(" AND ") +
      (multiple ? " GROUP BY t.fid" + (scope.all ? " HAVING COUNT(*)=?" : "") : ""),
    parameters: [
      ...tags.parameters,
      ...filter.parameters,
      ...(multiple && scope.all ? [scope.rules.length] : []),
    ],
  };
}

const listScope = (scope, everyRegion = false) => ({
  matchAll: scope.all,
  kind: scope.kind,
  regionIndex: !everyRegion && scope.areaIndex > 0 ? scope.areaIndex - 1 : -1,
});

function selectionCounts(db, dataset, params, res) {
  const scope = mapScope(db, dataset, params);
  if (!scope) return json(res, 400, { error: "Invalid selection." });
  if (scope.everything) {
    const filter = scopeFilter(scope, "f.fid");
    const total = db
      .prepare(
        "SELECT COUNT(*) AS count FROM map_features f" +
          (filter.clauses.length ? " WHERE " + filter.clauses.join(" AND ") : ""),
      )
      .get(...filter.parameters).count;
    return json(res, 200, {
      keyCount: total,
      matchCount: total,
      keys: [],
      values: [],
    });
  }
  const distinctCount = (rules) => {
    if (rules.length <= 1)
      return rules.length ? tagCount(db, scope, rules[0]) : 0;
    return matchingIds(db, rules, listScope(scope)).length;
  };
  const keyCount = distinctCount(
    scope.rules.map((rule) => ({ ...rule, values: [], valueIds: [] })),
  );
  const matchCount = scope.rules.some(({ values }) => values.length)
    ? distinctCount(scope.rules)
    : keyCount;
  return json(res, 200, {
    keyCount,
    matchCount,
    keys: scope.rules.map(({ key }) => [
      key,
      tagCount(db, scope, { key, values: [] }),
    ]),
    values: scope.rules.flatMap(({ key, values }) =>
      values.map((value) => [
        key,
        value,
        tagCount(db, scope, { key, values: [value] }),
      ]),
    ),
  });
}

const sampleOrder = "((fid * 2654435761) & 2147483647)";
// Tests lower this so a small fixture exercises the sampled path.
const sampleMinMatches = Number(process.env.WAYFINDER_SAMPLE_MIN_MATCHES || 50_000);
const sampleMinViewShare = 0.01;
const sampleMinValueShare = 0.05;
const sampleScanLimit = 200_000;
const listScanLimit = 200_000;
const listCheckSize = 20_000;

// The same order as the sample expression in SQL: only the low bits matter.
const sampleOf = (fid) => Math.imul(fid, 2654435761 | 0) & 2147483647;

// "Match all" over common keys can be rare even when each key is huge, which a
// sampled walk can't find. The ID lists give the exact matches instead.
function listedMatchIds(db, scope, view) {
  if (!scope.all || scope.rules.length < 2) return null;
  const ids = matchingIds(db, scope.rules, listScope(scope));
  if (ids.length > listScanLimit) return null;
  const ordered = Array.from(ids).sort((a, b) => sampleOf(a) - sampleOf(b));
  const limit = featureLimit + 1;
  if (view.wholeArea) return ordered.slice(0, limit);
  const inView = db.prepare(
    "SELECT m.fid FROM json_each(?) j CROSS JOIN map_bounds m ON m.fid=j.value " +
      "WHERE m.west<=? AND m.east>=? AND m.south<=? AND m.north>=?",
  );
  const found = [];
  for (let start = 0; start < ordered.length && found.length < limit; start += listCheckSize) {
    const batch = ordered.slice(start, start + listCheckSize);
    const seen = new Set(
      inView
        .all(JSON.stringify(batch), view.east, view.west, view.north, view.south)
        .map(({ fid }) => fid),
    );
    for (const fid of batch) if (seen.has(fid) && found.length < limit) found.push(fid);
  }
  return found;
}

// Finds the first matches in sample order and stops, instead of sorting every
// match. Returns their IDs, or null if this view should use the normal query:
// when matches are too few to be worth it, or too sparse to find in a short scan.
function sampledMatchIds(db, scope, sizes, size, view) {
  const { wholeArea, viewShare, east, west, north, south, filter } = view;
  if (
    size < sampleMinMatches ||
    viewShare < sampleMinViewShare ||
    scope.rules.some(
      (rule, index) =>
        rule.values.length &&
        sizes[index] <
          tagCount(db, scope, { key: rule.key, values: [] }) * sampleMinValueShare,
    )
  )
    return null;
  const everywhere = { kind: "all", region: "all" };
  const limit = featureLimit + 1;
  const requireAll = scope.all && scope.rules.length > 1;
  // For "match all", walk the rarest key and check the others on each object.
  const rarest = sizes.indexOf(Math.min(...sizes));
  const walked = requireAll ? [scope.rules[rarest]] : scope.rules;
  const others = requireAll
    ? scope.rules.filter((_, index) => index !== rarest)
    : [];
  const otherClauses = others.map(
    ({ valueIds }) =>
      "EXISTS (SELECT 1 FROM map_tags x WHERE x.key_id=? AND x.fid=t.fid" +
      (valueIds.length ? " AND x.value_id IN (" + placeholders(valueIds) + ")" : "") +
      ")",
  );
  const otherParameters = others.flatMap(({ keyId, valueIds }) => [keyId, ...valueIds]);
  const found = new Map();
  for (const rule of walked) {
    const rows = db
      .prepare(
        "SELECT t.fid, t.sample FROM (SELECT value_id, fid, " +
          sampleOrder +
          // The key_id>=0 term is what lets this query, and only this one, use the
          // partial index. Other queries keep their plans and result order.
          " AS sample FROM map_tags INDEXED BY map_tags_sample WHERE key_id>=0 AND key_id=?" +
          (rule.valueIds.length
            ? " AND value_id IN (" + placeholders(rule.valueIds) + ")"
            : "") +
          " ORDER BY sample LIMIT ?) t" +
          (wholeArea ? "" : " CROSS JOIN map_bounds m ON m.fid=t.fid") +
          filter.join +
          " WHERE " +
          [
            "1",
            ...(wholeArea
              ? []
              : ["m.west<=?", "m.east>=?", "m.south<=?", "m.north>=?"]),
            ...filter.clauses,
            ...otherClauses,
          ].join(" AND ") +
          " LIMIT ?",
      )
      .all(
        rule.keyId,
        ...rule.valueIds,
        sampleScanLimit,
        ...(wholeArea ? [] : [east, west, north, south]),
        ...filter.parameters,
        ...otherParameters,
        limit,
      );
    if (rows.length < limit && tagCount(db, everywhere, rule) > sampleScanLimit)
      return null;
    for (const { fid, sample } of rows) found.set(fid, sample);
  }
  return [...found]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([fid]) => fid);
}

function mapFeatures(db, dataset, params, res) {
  const scope = mapScope(db, dataset, params);
  const bounds = viewport(params);
  if (!scope || !bounds)
    return json(res, 400, {
      error: "Choose valid tag filters and map bounds.",
    });

  const [w, s, e, n] = dataset.areas[scope.areaIndex].bounds;
  const sizes = scope.rules.map((rule) => tagCount(db, scope, rule));
  const size = sizes.reduce((sum, count) => sum + count, 0);
  const featureCollection = {
    type: "FeatureCollection",
    limited: false,
    features: [],
  };
  if (
    !scope.everything &&
    (!size || (scope.all && sizes.some((count) => count === 0)))
  )
    return json(res, 200, featureCollection);
  const tags = tagConditions(scope.rules);
  const multiple = scope.rules.length > 1;
  const matchedTags = multiple
    ? "json_group_array(json_array(t.key_id,t.value_id))"
    : "json_array(json_array(t.key_id,t.value_id))";
  const grouping = multiple
    ? " GROUP BY t.fid" + (scope.all ? " HAVING COUNT(*)=?" : "")
    : "";
  const boxConditions = ["m.west<=?", "m.east>=?", "m.south<=?", "m.north>=?"];
  const boxes = viewportBoxes(bounds);
  const readBox = ({ west, south, east, north, offset }) => {
    if (scope.everything) {
      const filter = scopeFilter(scope, "m.fid");
      return db
        .prepare(
          "WITH hits AS MATERIALIZED (SELECT m.fid, '[]' AS tags, " +
            "((m.fid * 2654435761) & 2147483647) AS sample FROM map_bounds m" +
            filter.join +
            " WHERE " +
            [...boxConditions, ...filter.clauses].join(" AND ") +
            " ORDER BY sample LIMIT ?) " +
            "SELECT hits.tags, hits.sample, f.kind, f.osm_id, f.label, f.geometry FROM hits JOIN map_features f USING (fid)",
        )
        .all(east, west, north, south, ...filter.parameters, featureLimit + 1)
        .map((match) => ({ ...match, offset }));
    }
    // Areas across the antimeridian store continuous longitudes past 180, which
    // cannot be compared with this box, so they skip the quick rejection.
    const width =
      e > 180 || e - w > 180
        ? east - west
        : Math.max(0, Math.min(e, east) - Math.max(w, west));
    const height = Math.max(0, Math.min(n, north) - Math.max(s, south));
    if (!width || !height) return [];
    // Spatial lookup is cheaper for a zoomed-in view of a widely used key.
    const spatialFirst =
      size >= 4000 && width * height < 0.08 * (e - w) * (n - s);
    // A view holding the whole area can't exclude anything in that area, so the
    // location lookup for every match is skipped. The margin allows for rounding.
    const margin = 0.001;
    const wholeArea =
      boxes.length === 1 &&
      e <= 180 &&
      west <= w - margin &&
      east >= e + margin &&
      south <= s - margin &&
      north >= n + margin;
    const filter = scopeFilter(scope, "t.fid");
    const view = {
      wholeArea,
      viewShare: (width * height) / ((e - w) * (n - s)),
      east,
      west,
      north,
      south,
      filter,
    };
    const sampled =
      boxes.length === 1 && e <= 180
        ? (listedMatchIds(db, scope, view) ??
          sampledMatchIds(db, scope, sizes, size, view))
        : null;
    // Once the sampled objects are known, only their tags still need reading.
    const tables =
      sampled || wholeArea
        ? "map_tags t"
        : spatialFirst
          ? "map_bounds m CROSS JOIN map_tags t ON t.fid=m.fid"
          : "map_tags t CROSS JOIN map_bounds m ON m.fid=t.fid";
    const conditions = sampled
      ? [tags.clause, "t.fid IN (SELECT value FROM json_each(?))"]
      : [tags.clause, ...(wholeArea ? [] : boxConditions), ...filter.clauses];
    const parameters = sampled
      ? [...tags.parameters, JSON.stringify(sampled)]
      : [
          ...tags.parameters,
          ...(wholeArea ? [] : [east, west, north, south]),
          ...filter.parameters,
        ];
    if (multiple && scope.all) parameters.push(scope.rules.length);
    return db
      .prepare(
        "WITH hits AS MATERIALIZED (SELECT t.fid, " +
          matchedTags +
          " AS tags, ((t.fid * 2654435761) & 2147483647) AS sample FROM " +
          tables +
          (sampled ? "" : filter.join) +
          " WHERE " +
          conditions.join(" AND ") +
          grouping +
          // A stable sample avoids showing only objects with the earliest OSM IDs.
          " ORDER BY sample LIMIT ?) " +
          "SELECT hits.tags, hits.sample, f.kind, f.osm_id, f.label, f.geometry FROM hits JOIN map_features f USING (fid)",
      )
      .all(...parameters, featureLimit + 1)
      .map((match) => ({ ...match, offset }));
  };
  let matches = boxes.flatMap(readBox);
  if (boxes.length > 1) {
    // A wide object can touch both sides of the antimeridian.
    const unique = new Map();
    for (const match of matches)
      if (!unique.has(match.kind + match.osm_id))
        unique.set(match.kind + match.osm_id, match);
    matches = [...unique.values()].sort((a, b) => a.sample - b.sample);
  }
  featureCollection.limited = matches.length > featureLimit;
  const shown = matches
    .slice(0, featureLimit)
    .map((match) => ({ ...match, tags: JSON.parse(match.tags) }));
  const values = valueNames(
    db,
    new Set(shown.flatMap(({ tags }) => tags.map(([, value]) => value))),
  );
  featureCollection.features = shown.map((match) => {
    const tags = match.tags
      .map(([key, value]) => [keyName(db, key), values.get(value)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      type: "Feature",
      id: match.kind + "/" + match.osm_id,
      properties: {
        kind: match.kind,
        id: match.osm_id,
        label: match.label,
        tags,
        value: tags[0]?.[1] ?? null,
      },
      geometry: shiftGeometry(decodeGeometry(match.geometry), match.offset),
    };
  });
  return json(res, 200, featureCollection);
}

async function formParameters(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= 128 * 1024) chunks.push(chunk);
  }
  return length > 128 * 1024
    ? null
    : new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const isIndexedKey = (db, dataset, key) =>
  (db
    .prepare("SELECT values_all FROM tag_keys WHERE region='all' AND key=?")
    .get(key)?.values_all ?? 0) >= dataset.searchMinValues;

export const freshnessRollupName = (areaIndex, kind, key, value) =>
  JSON.stringify([areaIndex, kind, key, value]);

export function computeFreshness(db, dataset, scope) {
  return queryFreshness(
    db,
    dataset,
    dataset.areas[scope.areaIndex],
    matchedObjects(scope),
    matchedObjects(scope, true),
  );
}

// The answer stored at build time, for selections common enough to be slow.
function storedFreshness(db, { areaIndex, kind, rules }) {
  if (rules.length > 1 || rules[0]?.values.length > 1) return null;
  const [rule] = rules;
  const row = db
    .prepare("SELECT payload FROM freshness_rollups WHERE name=?")
    .get(
      freshnessRollupName(
        areaIndex,
        kind,
        rule?.key ?? null,
        rule?.values[0] ?? null,
      ),
    );
  return row ? inflateSync(row.payload) : null;
}

function rawJson(res, body) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": res.cacheControl || "no-store",
  });
  res.end(body);
}

function objectDetails(db, dataset, kind, id, res) {
  if (!dataset.areas[0]?.bounds)
    return json(res, 503, {
      error: "Run npm run analytics:prepare to index map features.",
    });
  if (!Number.isSafeInteger(id))
    return json(res, 400, { error: "Invalid OpenStreetMap object ID." });
  const item = db
    .prepare(
      "SELECT f.fid, f.label, f.geometry, b.west, b.south, b.east, b.north " +
        "FROM map_features f JOIN map_bounds b USING (fid) WHERE f.kind=? AND f.osm_id=?",
    )
    .get(kind, id);
  if (!item)
    return json(res, 404, {
      error: "This object is not in the local extract.",
    });
  const tags = db
    .prepare(
      "SELECT k.key, v.value FROM map_tags t " +
        "CROSS JOIN tag_key_names k ON k.id=t.key_id " +
        "CROSS JOIN tag_value_names v ON v.id=t.value_id " +
        "WHERE t.fid=? ORDER BY k.key COLLATE NOCASE, k.key",
    )
    .all(item.fid);
  const geometry = decodeGeometry(item.geometry);
  const freshness = db
    .prepare("SELECT version, edited FROM feature_freshness WHERE fid=?")
    .get(item.fid);
  return json(res, 200, {
    kind,
    id,
    version: freshness?.version ?? null,
    edited: freshness?.edited ?? null,
    label: item.label,
    geometry: geometry.type,
    coordinates: geometry.type === "Point" ? geometry.coordinates : null,
    bounds: [item.west, item.south, item.east, item.north],
    regions: db
      .prepare("SELECT region FROM feature_regions WHERE fid=? ORDER BY region")
      .all(item.fid)
      .map(({ region }) => dataset.areas[region + 1].name),
    tags,
  });
}

export async function serveAnalytics(
  req,
  res,
  url,
  { analyticsDir: directory, imageryDir },
) {
  const post =
    req.method === "POST" &&
    /^\/api\/analytics\/[A-Z]{2}\/(tags|features|selection|freshness|tag-regions)$/.test(
      url.pathname,
    );
  if (req.method !== "GET" && !post)
    return json(res, 405, { error: "Method not allowed." });
  const tile =
    /^\/api\/analytics\/LU\/imagery\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.jpeg$/.exec(
      url.pathname,
    );
  if (tile) return serveImagery(res, imageryDir, ...tile.slice(1).map(Number));
  if (url.pathname === "/api/analytics") {
    // Run locally, a country that has just been built has to appear at once.
    res.cacheControl =
      process.env.WAYFINDER_PUBLIC === "1" ? CACHE_BRIEFLY : "no-store";
    const countries = [];
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Z]{2}\.sqlite$/.test(entry.name)) continue;
        try {
          countries.push(openCountry(join(directory, entry.name)).dataset.country);
        } catch (error) {
          // One country waiting for a rebuild shouldn't hide the others.
          if (!error.outdatedDatabase) throw error;
        }
      }
    }
    return json(
      res,
      200,
      countries.sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  const object =
    /^\/api\/analytics\/([A-Z]{2})\/object\/(node|way|relation)\/([1-9]\d{0,15})$/.exec(
      url.pathname,
    );
  const match =
    /^\/api\/analytics\/([A-Z]{2})(?:\/(tags|map|features|selection|nearby|freshness|tag-regions))?$/.exec(
      url.pathname,
    );
  if (!match && !object)
    return json(res, 404, { error: "Analytics endpoint not found." });
  const file = join(directory, (object || match)[1] + ".sqlite");
  if (!existsSync(file))
    return json(res, 404, { error: "This country has not been prepared." });

  let opened;
  try {
    opened = openCountry(file);
  } catch (error) {
    if (!error.outdatedDatabase) throw error;
    return json(res, 503, {
      error: "This country's database is out of date and must be rebuilt.",
    });
  }
  const { db, dataset } = opened;
  res.cacheControl =
    !post && url.searchParams.get("v") === dataset.version
      ? CACHE_FOREVER
      : CACHE_BRIEFLY;
  if (object)
    return objectDetails(db, dataset, object[2], Number(object[3]), res);
  if (!match[2]) return json(res, 200, dataset);

  const params = post ? await formParameters(req) : url.searchParams;
  if (!params)
    return json(res, 413, { error: "Tag selection is too large." });
  if (match[2] !== "tags") {
    if (!dataset.areas[0]?.bounds) {
      return json(res, 503, {
        error: "Run npm run analytics:prepare to index map features.",
      });
    }
    if (match[2] === "selection")
      return selectionCounts(db, dataset, params, res);
    if (match[2] === "tag-regions") {
      const key = params.get("key");
      const kind = params.get("kind") || "all";
      if (key === null || !Object.hasOwn(objectCounts, kind))
        return json(res, 400, { error: "Choose a tag key and object type." });
      return json(
        res,
        200,
        tagRegions(db, dataset, {
          key,
          kind,
          focus: [...new Set(params.getAll("focus"))].slice(0, 40),
          count: objectCounts[kind],
          distinct: valueCounts[kind],
        }),
      );
    }
    if (match[2] === "freshness") {
      const scope = mapScope(db, dataset, params);
      if (!scope) return json(res, 400, { error: "Invalid selection." });
      const stored = storedFreshness(db, scope);
      return stored
        ? rawJson(res, stored)
        : json(res, 200, computeFreshness(db, dataset, scope));
    }
    if (match[2] === "nearby") {
      const result = queryNearby(db, params);
      return result
        ? json(res, 200, result)
        : json(res, 400, {
            error:
              "Enter valid coordinates and a radius between 25 m and 2 km.",
          });
    }
    return match[2] === "map"
      ? json(res, 200, mapPlaces(db))
      : mapFeatures(db, dataset, params, res);
  }
  const region = params.get("region") || "all";
  const kind = params.get("kind") || "all";
  const area = dataset.areas.find((item) => item.id === region);
  if (!area || !Object.hasOwn(objectCounts, kind)) {
    return json(res, 400, {
      error: "Choose a valid region and object type.",
    });
  }
  const key = params.get("key");
  const search = (params.get("q") || "").slice(0, 255);
  const count = objectCounts[kind];
  const parameters = [region];
  const conditions = ["region = ?", "(" + count + ") > 0"];
  if (key !== null) {
    conditions.push("key = ?");
    parameters.push(key);
  }
  if (search) {
    // Three characters is the shortest thing the substring index can look up.
    if (key !== null && [...search].length >= 3 && isIndexedKey(db, dataset, key)) {
      conditions.push(
        "value IN (SELECT n.value FROM value_search " +
          "CROSS JOIN tag_value_names n ON n.id=value_search.rowid " +
          "WHERE value_search MATCH ?)",
      );
      parameters.push('"' + search.replaceAll('"', '""') + '"');
    }
    conditions.push(
      "instr(unicode_lower(" +
        (key === null ? "key" : "value") +
        "), ?) > 0",
    );
    parameters.push(search.toLowerCase());
  }
  const name = key === null ? "key" : "value";
  const table = key === null ? "tag_keys" : "tag_values";
  const where = " FROM " + table + " WHERE " + conditions.join(" AND ");
  const columns =
    key === null
      ? "key, nodes, ways, relations, " +
        valueCounts[kind] +
        " AS distinct_values"
      : "value, nodes, ways, relations, node_id, way_id, relation_id";
  const order =
    params.get("sort") === "name"
      ? name + " COLLATE NOCASE, " + name
      : "count DESC, " + name + " COLLATE NOCASE, " + name;
  const select =
    "SELECT " +
    columns +
    ", " +
    count +
    " AS count" +
    where +
    " ORDER BY " +
    order;

  if (params.get("format") === "csv") {
    const scope = [
      dataset.country.name,
      region,
      area.name,
      dataset.snapshot,
      kind,
    ];
    if (key !== null) scope.push(key);
    await exportRows(
      res,
      db.prepare(select),
      parameters,
      key !== null,
      scope,
    );
    return;
  }
  const total = db
    .prepare("SELECT COUNT(*) AS total" + where)
    .get(...parameters).total;
  const requested = Number(params.get("page") || 1);
  const page = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, Math.ceil(total / pageSize)))
    : 1;
  const rows = db
    .prepare(select + " LIMIT ? OFFSET ?")
    .all(...parameters, pageSize, (page - 1) * pageSize);
  if (params.get("view") === "options")
    return json(res, 200, { rows, total, page, pageSize });
  const tag =
    key === null
      ? null
      : db
          .prepare(
            "SELECT " +
              count +
              " AS count, " +
              valueCounts[kind] +
              " AS distinct_values FROM tag_keys WHERE region=? AND key=?",
          )
          .get(region, key);
  let comparison = null;
  let distribution = null;
  if (key !== null) {
    const top = db
      .prepare(
        "SELECT value, " +
          count +
          " AS count FROM tag_values WHERE region=? AND key=? AND (" +
          count +
          ") > 0 ORDER BY count DESC, value COLLATE NOCASE, value LIMIT ?",
      )
      .all(region, key, chartSize);
    distribution = {
      top,
      otherCount:
        (tag?.count ?? 0) - top.reduce((sum, row) => sum + row.count, 0),
      otherValues: (tag?.distinct_values ?? 0) - top.length,
    };
    const focus = [...new Set(params.getAll("focus"))].slice(0, 40);
    const byRegion = db.prepare(
      "SELECT SUM(" +
        count +
        ") AS count FROM " +
        (focus.length ? "tag_values" : "tag_keys") +
        " WHERE region=? AND key=?" +
        (focus.length ? " AND value IN (" + placeholders(focus) + ")" : ""),
    );
    comparison = Object.fromEntries(
      dataset.areas.map(({ id }) => {
        const entry = byRegion.get(id, key, ...focus);
        return [id, entry?.count ?? 0];
      }),
    );
  }
  return json(res, 200, {
    rows,
    total,
    page,
    pageSize,
    tag: tag || null,
    distribution,
    comparison,
  });
}
