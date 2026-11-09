# Wayfinder audit: code, architecture and world-scale performance

Audited 9 Nov 2026, against the Luxembourg dataset (snapshot 7 Nov 2026).

Findings marked **Fixed** were reproduced on the running code, fixed, and now have tests. **By reading** means found in the source but not triggered, and still open. World figures are projections, explained below.

## Status, later on 9 Nov 2026

The server, caching, query and storage work below has since been done, and the figures in this file describe the code before it. Still open from this audit: replacing the in-memory Python pipeline for planet-scale builds (item 2), country-specific imagery beyond Luxembourg, code finding C6, the imagery cache size limit, and splitting up the large server and map files. See the git history for what changed.

| Measure (Austria, warm cache, one request at a time) | Before | After |
|---|---|---|
| Database | 11.5 GB | 5.8 GB plus 87 MB of tiles |
| Freshness, all objects | 23 s | under 1 ms |
| Freshness, `building` | 9 s | under 1 ms |
| Selection, two keys | 1.2–1.4 s | 12–21 ms |
| Features, two keys, match all | 2.6 s | 16 ms |
| Nearby, 250 m | 943 ms | 58 ms |
| Nearby, 2 km | 1,490 ms | 449 ms |
| Value search | 305 ms | 123 ms |
| Map context | 3.9 MB | 943 KB, 111 KB compressed |

## Second review, 9–10 Nov 2026

A read-only review of the MapLibre version, with India (27.8M objects) as the large test country. Every finding below is fixed and tested unless marked open.

| Finding | Status | Resolution |
|---|---|---|
| The map drew 1,200 of N objects without saying so | Fixed | A note says when the view is a sample |
| Freshness with several keys timed out at 15 s on India | Fixed | Estimated from a 250,000-object sample (2.0 s), labelled as an estimate. **Match all** stays exact |
| **Every object** took 12.6 s on India | Fixed | IDs are generated in sample order, so nothing is sorted (16 ms) |
| **Match all** showed nothing, because each new key started on its most common value | Fixed | Only the first key starts on a value. Later keys start on all values |
| Freshness showed every object when no key was chosen | Fixed | It asks for a key, or **All keys** |
| The value picker label showed another key's value | Fixed | It describes the key it lists |
| Quick clicks could pass the 12-key limit, or add a key to a newly chosen country | Fixed | Pending keys count toward the limit and are dropped on a country change |
| `Range: bytes=-100` returned the whole tile file | Fixed | Suffix ranges return the last n bytes |
| A crash while saving a satellite tile could cache a broken tile (C4) | Fixed | Tiles are written to a temporary file and renamed |
| India's place list was 27.8 MB and re-parsed on every request | Fixed | Compact rows, parsed once: 6.3 MB, 13 ms when cached |
| Every country stayed open in every query worker | Fixed | Each worker keeps 3 open (`WAYFINDER_OPEN_COUNTRIES`) |
| Rebuilds silently keep a full copy of the old database (`*.previous.sqlite`, 12 GB here) | Documented | The README explains these files and when to delete them |
| A build without the Python environment or tippecanoe failed with "The build tools couldn't start" | Fixed | The build names what is missing and how to fix it. The README has a troubleshooting table |
| Luxembourg failed to build from a fresh clone, because only `npm run analytics:download` fetched its cantons | Fixed | The build downloads and checks hand-checked boundaries, and falls back to automatic regions |
| The first heavy query after a restart takes 1.2–1.8 s while the database is read from disk | Open, accepted | Warming several GB at every start would cost local users more than it saves |
| A small coastal country, such as Monaco, opens zoomed out over its territorial waters | Open | Fit to the data's extent rather than the boundary |

| Measure (India, warm cache) | Before | After |
|---|---|---|
| Every object, whole country | 2.9 s | 16 ms |
| Every object, ways only | 11 s | 127 ms |
| Every object, relations only | 10.5 s | 10 ms |
| Freshness, `highway` + `building` | over 15 s (timeout) | 2.0 s, estimated |
| Map places | 27.8 MB | 6.3 MB, 2.35 MB compressed |

## Summary

The app is well built for one small country. Queries are parameterised, files are swapped atomically, requests are debounced and cancelled, and static serving resists path traversal.

The pipeline now builds any country, but the design still cannot run on the world. Two things stop it: the pipeline holds everything in memory on one core, and the server runs every query on its single thread.

## Measured baseline

| Measure (Luxembourg) | Result |
|---|---|
| Input PBF | 47.9 MB |
| Full pipeline run | 127 s on one core |
| Peak memory | 598 MB |
| SQLite output | 559 MB (11.7x the input) |
| Features / tag rows | 855,480 / 2,729,048 |
| Geometry text | 247 MB, of which 75 MB is 6,856 relations (0.8% of rows) |
| Tag tables and indexes | 185 MB |

| API scenario | p50 | Response |
|---|---|---|
| Features, `highway`, whole country | 200 ms | 402 KB |
| Features, `highway`, one city | 10 ms | 350 KB |
| Selection, two keys | 61 ms | under 1 KB |
| Detail map, city, zoom 16 | 28 ms | 921 KB |
| Nearby, 250 m | 140 ms | 32 KB |
| Nearby, 2 km | 344 ms | 32 KB |
| Trivial request during one slow query | 182 ms | blocked behind it |

Run `npm run test:perf` to refresh these. Results go to `output/reports/perf.json`.

## World projection

The planet PBF is about 90 GB (from memory, not measured), or about 1,900x Luxembourg. Scaling linearly:

| Resource | Luxembourg | Planet, same design |
|---|---|---|
| Pipeline time | 127 s | about 68 hours on one core |
| Peak memory | 598 MB | about 1.1 TB |
| SQLite | 559 MB | about 1.1 TB |

For a single large country, assume the US has about 175x Luxembourg's roads (an estimate):

| Query | Luxembourg | US, same design |
|---|---|---|
| Features, `highway`, whole country | 200 ms | about 35 s, blocking every other user |
| Selection, two keys | 61 ms | about 11 s |
| Values of `name` | 9 ms | about 1.6 s |

Single-key counts are precomputed and stay fast.

## Performance work needed for the world, in order

1. **Done: country-agnostic pipeline (A1, A2).** Add a file in `code/pipeline/countries/` and run with `--country`.
2. **Replace in-memory Python processing.** `member_geometry`, `relation_members` and `relations` hold all geometry and membership in Python objects, and `flex_mem` holds node locations in RAM (`prepare-analytics.py:101,328,357`). Use a compiled exporter to GeoParquet, a disk-backed node index, and DuckDB for the region joins, one partition per core.
3. **Move queries off the server thread.** `node:sqlite` is synchronous, so one slow query stalls everyone (measured above). Use a worker pool with one read-only connection per worker, and a query timeout.
4. **Stop sorting every match.** `ORDER BY` on a hash reads and sorts every match to return 1,200 (`analytics.mjs:370`). Store a precomputed sample rank, and draw zoomed-out views from vector tiles.
   The Freshness view has the same limit: it reads every matching object per request (405 ms for `highway`, 1.5 s for all objects in Luxembourg). Precompute it per region and key before larger countries.
5. **Stop storing giant relations as display geometry.** The European Union relation is 850 KB of GeoJSON, and three relations repeat it. Every nearby query in the country parses them (2.8 ms each), which is why a 250 m search costs 140 ms. Keep a bounding box and simplified geometry, and exclude abstract relations from exact-distance checks.
6. **Compact geometry storage.** Replace GeoJSON text with WKB or a delta encoding at 7 decimals. Geometry is about 45% of the database.
7. **Cache per-database state.** Each request opens the file and parses the full metadata JSON (`analytics.mjs:24`). That is 0.67 ms at 168 KB today, but metadata grows with region count, and `/api/analytics` opens every country file on each call (`analytics.mjs:464`).
8. **Skip redundant JSON work and compress.** Geometry is parsed and re-serialised for every feature (`analytics.mjs:146,387`), when the stored text could be concatenated. Add gzip or Brotli. Replace `no-store` with an ETag based on the snapshot, because data only changes weekly.
9. **Stream downloads.** Both download scripts buffer the entire file in memory with a 3-minute timeout (`download-analytics.mjs:16,26`).
10. **Project per feature, or measure geodesically.** `shapely.ops.transform` is called per geometry through Python (`prepare-analytics.py:199,225`), and EPSG:2169 is only valid for Luxembourg.

## Code findings

| ID | Severity | Finding | Status | Resolution |
|---|---|---|---|---|
| C1 | Critical | One `GET //` request killed the server, because `new URL()` threw outside the `try`. | Fixed | Both servers now return 400 |
| C2 | High | Search was case-sensitive for non-ASCII. `église` found 3 names, `Église` 48. SQLite `lower()` only folds ASCII. | Fixed | Search folds with a Unicode-aware SQL function |
| A1 | Blocker for world | Build required exactly 12 cantons and hard-coded EPSG:2169, country ID, name and source URLs. | Fixed | Country config files. Without a national CRS, an equal-area projection is centred on the regions |
| A2 | Blocker for world | Regions were bits in an integer, and JavaScript `<<` wraps at 32 bits. | Fixed | New `feature_regions` table with no limit. Needed a database rebuild |
| A3 | High for world | A viewport past 180 degrees returned 400, and nearby did not wrap. | Fixed | Viewports and nearby split at the line, and results return in the map's frame. Straddling countries store continuous longitudes. One gap remains, below |
| C3 | Medium | Static file stream has no error handler, so a file removed during a deploy can crash the process. | By reading | `index.mjs:80` |
| C4 | Medium | Imagery tiles are written non-atomically, so a crash can cache a truncated tile. The cache also has no size limit. | Partly fixed | Writes are atomic. The cache still has no size limit |
| C5 | Low | `vite`, a dev dependency, is imported at the top even in production, so `npm ci --omit=dev` would break startup. | By reading | `index.mjs:4` |
| C6 | Low | An oversized POST body is still read to the end before it is refused. | By reading | `analytics.mjs:formParameters` |
| C7 | Low | `npm test` silently excluded the 6 routing tests before this audit. They are now included. | Fixed | `package.json` |

Remaining gap in A3, by reading: the nearby tool wraps its centre to the -180 to 180 range (`AnalyticsFeatureMap.tsx`, `beginNearby`). East of 180 in a straddling country, the circle and map jump to the neighbouring world copy, where region outlines are not drawn. Results and distances are correct.

## Architecture audit

### Input

- **Good:** PBF checksums are verified, boundary files are pinned by hash, and writes go through a temp file.
- **Gap:** only the latest file is kept, with no dated snapshots or manifest, so a bad week cannot be rolled back or reproduced.
- **Gap:** one Geofabrik download per country will not scale. Use one planet file with a dated path.
- **Gap:** boundaries are hand-picked per country. World coverage needs OSM admin relations or Overture divisions, stored as a versioned table.

### Pipeline

- **Good:** indexes are built after loading, and the output replaces the old file atomically.
- **Gap:** one script goes straight from PBF to the serving database, with no intermediate layer. Every new output means re-reading the PBF, which this script already does three times per run.
- **Gap:** there is no validation gate. A broken extract replaces a good database if the build merely finishes. Compare counts with the previous snapshot first.

### Server

- **Good:** parameterised SQL, allow-listed columns, CSV formula protection, binds to localhost only.
- **Gap:** `analytics.mjs` is 668 lines combining routing, validation, SQL and responses, and `serveAnalytics` alone is over 220 lines.
- **Gap:** no health endpoint, structured logs, metrics or timeouts in the active server, so it is not deployable beyond localhost yet.
- **Gap:** imagery is hard-coded to one country's provider.

### UI

- **Good:** requests are debounced and cancelled, and detail layers use canvas.
- **Gap:** filters are not in the URL, so a view cannot be shared or restored.
- **Gap:** `Analytics.tsx` (1,256 lines) and `AnalyticsFeatureMap.tsx` (1,036 lines) hold most state and logic in single components.
- **Gap:** matching features use Leaflet's SVG renderer, one DOM node each. Large countries need MapLibre with vector tiles, because a random 1,200-feature sample misrepresents density.
- **Gap:** no React error boundary, so one render error blanks the page.
- **Gap:** `minZoom: 7` and Luxembourg wording in `index.html` assume one small country.

### Project

- Done: the project is a git repository.
- Done: the inactive routing app is removed.
- Done: CI runs the tests on every push. There is still no linter or Python dependency lock.

## Tests

| Tier | Command | Covers |
|---|---|---|
| Unit | `npm run test:unit`, `npm run test:py` | Validation, CSV, imagery cache, paths, geometry rules, themes, region clipping, relation cycles |
| Smoke | `npm run test:smoke` | Production and dev servers boot, assets load, every endpoint answers, pipeline scripts parse |
| Integration | `npm run test:integration` | Fixture through the real pipeline and HTTP API with exact results, plus the real Luxembourg database |
| Regression | `npm run test:regression` | 11 golden API responses and every fixed bug |
| Visual | `npm run test:visual` | Screenshots on desktop and mobile, right-click menu, inspector, filters, nearby |
| Performance | `npm run test:perf` | Latency budgets on real data |

`npm run test:all` builds and runs everything except performance.

Every fixed bug has tests in `code/tests/regression/audit-fixes.test.mjs` or `code/tests/integration/any-country.test.mjs`. The second uses a synthetic country with 40 regions straddling 180 degrees.

Visual baselines are macOS-only and live in `code/tests/visual/baseline`.
