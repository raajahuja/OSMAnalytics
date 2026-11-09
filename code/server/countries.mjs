// The Countries page: every country, what the download site offers for it, what
// is on this computer, and what the app can show. Downloads are the only action
// so far; nothing here changes a database.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBuildManager } from "./builds.mjs";
import { createActivityLog, createDownloadManager } from "./downloads.mjs";

const INDEX_URL = "https://download.geofabrik.de/index-v1-nogeom.json";
const FILE_HOST = "download.geofabrik.de";
const FILE_SUFFIX = "-latest.osm.pbf";
const USER_AGENT = "wayfinder-local-app";
const CATALOG_FILE = "catalog.json";

// Extracts are rebuilt daily, so one check a day is enough.
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const LOOKUPS_AT_ONCE = 3;

// ISO 3166-1, plus XK, the code in common use for Kosovo.
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ " +
  "BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM " +
  "DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS " +
  "GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
  "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
  "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM " +
  "PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV " +
  "SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
  "VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

// The site's own country codes are wrong or missing for these extracts. Several
// Pacific territories are all labelled VU or MH, and shared files omit members.
// An empty list means the extract does not map to a country we can confirm.
const CODE_CORRECTIONS = new Map([
  ["american-oceania", []],
  ["ile-de-clipperton", []],
  ["polynesie-francaise", ["PF"]],
  ["tokelau", ["TK"]],
  ["wallis-et-futuna", ["WF"]],
  ["pitcairn-islands", ["PN"]],
  ["malaysia-singapore-brunei", ["MY", "SG", "BN"]],
  ["gcc-states", ["QA", "AE", "OM", "BH", "KW", "SA"]],
  ["comores", ["KM"]],
  ["isle-of-man", ["IM"]],
  ["guernsey-jersey", ["GG", "JE"]],
  ["kosovo", ["XK"]],
  ["bermuda", ["BM"]],
  ["falklands", ["FK"]],
  ["hong-kong", ["HK"]],
  ["svalbard-janmayen", ["SJ"]],
  ["guadeloupe", ["GP"]],
  ["martinique", ["MQ"]],
  ["mayotte", ["YT"]],
  ["reunion", ["RE"]],
]);

// Measured on Austria with the parallel build: 814.85 MB extract, 5,077 MB peak
// memory, 10.10 GB database, 1,160 s. Other countries scale from these.
const EXTRACT_MB = 814.85;
const MEMORY_PER_BYTE = 5077 / EXTRACT_MB;
const DATABASE_PER_BYTE = 10101 / EXTRACT_MB;
const SECONDS_PER_BYTE = 1160 / (EXTRACT_MB * 1e6);
const GIB = 1024 ** 3;
const MEMORY_RESERVE = 6 * GIB;
const DISK_RESERVE = 10 * GIB;

// The catalog is remote data that picks URLs to request and file names to read,
// so both are limited to the exact shape of a real extract.
export function extractSlug(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== FILE_HOST) return null;
  const file = parsed.pathname.split("/").pop();
  if (!file.endsWith(FILE_SUFFIX)) return null;
  const slug = file.slice(0, -FILE_SUFFIX.length);
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

export function parseCatalog(index) {
  const entries = index.features.map((feature) => feature.properties);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootOf = (entry) => {
    let current = entry;
    for (let depth = 0; current.parent && depth < 8; depth++) {
      const parent = byId.get(current.parent);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  return entries.flatMap((entry) => {
    const codes = CODE_CORRECTIONS.get(entry.id) ?? entry["iso3166-1:alpha2"];
    const pbf = entry.urls?.pbf;
    if (!codes?.length || !extractSlug(pbf)) return [];
    return [
      {
        id: entry.id,
        name: entry.name,
        continent: rootOf(entry).name,
        pbf,
        codes,
      },
    ];
  });
}

export function estimateBuild(bytes, machine, alreadyDownloaded = false) {
  if (!bytes) return null;
  const memoryBytes = Math.round(bytes * MEMORY_PER_BYTE);
  const diskBytes = Math.round(
    bytes * DATABASE_PER_BYTE + (alreadyDownloaded ? 0 : bytes),
  );
  const memoryFits = memoryBytes <= machine.memoryBytes - MEMORY_RESERVE;
  const diskFits = diskBytes <= machine.freeDiskBytes - DISK_RESERVE;
  return {
    memoryBytes,
    diskBytes,
    seconds: Math.round(bytes * SECONDS_PER_BYTE),
    fits: memoryFits && diskFits,
    limit: !memoryFits ? "memory" : !diskFits ? "disk" : null,
  };
}

export function nextStep({ website, downloaded, app, updateAvailable, estimate }) {
  if (!website) return app ? "up-to-date" : "unavailable";
  const current =
    downloaded &&
    app &&
    !updateAvailable &&
    downloaded.modifiedMs <= (app.builtMs ?? 0);
  if (current) return "up-to-date";
  if (estimate && !estimate.fits) return "too-large";
  if (downloaded && app) return updateAvailable ? "refresh" : "build";
  if (app) return "refresh";
  if (downloaded) return "build";
  return "download-and-build";
}

// Starting a download is a state change on a localhost server, so it must come
// from this app's own page. Any website could otherwise POST to localhost.
export function isOwnPageRequest(req) {
  const { host, origin } = req.headers;
  if (!host || !origin) return false;
  try {
    const { hostname } = new URL("http://" + host);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return false;
    const from = new URL(origin);
    return from.protocol === "http:" && from.host === host;
  } catch {
    return false;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function freeDisk(directory) {
  let current = directory;
  while (!existsSync(current) && path.dirname(current) !== current)
    current = path.dirname(current);
  const { bavail, bsize } = statfsSync(current);
  return bavail * bsize;
}

function fileInfo(file) {
  try {
    const info = statSync(file);
    return info.isFile() ? info : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

export function createCountryService({
  inputDir,
  analyticsDir,
  cacheDir,
  fetchImpl = fetch,
  now = Date.now,
  stallMs,
  repoRoot = path.resolve(import.meta.dirname, "../.."),
  spawnImpl,
  machine = () => ({
    memoryBytes: os.totalmem(),
    freeDiskBytes: freeDisk(analyticsDir),
  }),
}) {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const cacheFile = path.join(cacheDir, CATALOG_FILE);
  const progress = { running: null, done: 0, total: 0, error: null, tried: 0 };
  const databases = new Map();
  const activity = createActivityLog({ now });
  const downloads = createDownloadManager({
    directory: path.join(inputDir, "osm"),
    fetchImpl,
    activity,
    ...(stallMs ? { stallMs } : {}),
  });
  const builds = createBuildManager({
    repoRoot,
    inputDir,
    analyticsDir,
    activity,
    now,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  let catalog = readCache();

  function readCache() {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
      return Array.isArray(cached.entries) ? cached : null;
    } catch {
      return null;
    }
  }

  function writeCache() {
    mkdirSync(cacheDir, { recursive: true });
    const temporary = cacheFile + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(catalog));
    renameSync(temporary, cacheFile);
  }

  async function lookUpFile(url) {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("File lookup failed: " + response.status);
    const bytes = Number(response.headers.get("content-length"));
    const modified = Date.parse(response.headers.get("last-modified"));
    return {
      bytes: bytes > 0 ? bytes : null,
      modifiedMs: Number.isFinite(modified) ? modified : null,
    };
  }

  async function refreshCatalog() {
    progress.error = null;
    progress.done = 0;
    progress.total = 0;
    progress.tried = now();
    try {
      const response = await fetchImpl(INDEX_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error("Catalog request failed: " + response.status);
      const entries = parseCatalog(await response.json());
      if (!entries.length) throw new Error("The catalog listed no countries.");
      const files = { ...catalog?.files };
      catalog = { checkedMs: catalog?.checkedMs ?? null, entries, files };
      const pending = [...new Set(entries.map((entry) => entry.pbf))];
      progress.total = pending.length;
      let failures = 0;
      await Promise.all(
        Array.from({ length: LOOKUPS_AT_ONCE }, async () => {
          while (pending.length) {
            const url = pending.pop();
            try {
              files[url] = await lookUpFile(url);
            } catch {
              failures++;
            }
            progress.done++;
          }
        }),
      );
      if (failures === progress.total)
        throw new Error("No file details could be read from the website.");
      catalog = { checkedMs: now(), entries, files };
      writeCache();
    } catch (error) {
      progress.error = error.message;
      console.error("Country catalog refresh failed:", error.message);
    }
  }

  function refreshIfStale() {
    if (progress.running) return;
    const age = now() - (catalog?.checkedMs ?? 0);
    if (age < CATALOG_MAX_AGE_MS) return;
    if (progress.tried && now() - progress.tried < RETRY_AFTER_MS) return;
    progress.running = refreshCatalog().finally(() => {
      progress.running = null;
    });
  }

  function databaseInfo(code) {
    const file = path.join(analyticsDir, code + ".sqlite");
    const info = fileInfo(file);
    if (!info) {
      databases.delete(code);
      return null;
    }
    const cached = databases.get(code);
    if (cached?.builtMs === info.mtimeMs && cached.bytes === info.size)
      return cached;
    const entry = { bytes: info.size, builtMs: info.mtimeMs, snapshot: null };
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("SELECT summary FROM metadata LIMIT 1").get();
      entry.snapshot = JSON.parse(row.summary).snapshot ?? null;
    } catch {
      entry.unreadable = true;
    } finally {
      db?.close();
    }
    databases.set(code, entry);
    return entry;
  }

  function downloadedFile(slug) {
    for (const name of [slug + ".osm.pbf", slug + "-latest.osm.pbf"]) {
      const file = path.join(inputDir, "osm", name);
      const info = fileInfo(file);
      if (info) return { file, info };
    }
    return null;
  }

  function downloadedInfo(slug) {
    const found = downloadedFile(slug);
    return found
      ? { bytes: found.info.size, modifiedMs: found.info.mtimeMs }
      : null;
  }

  function currentOffers() {
    const offers = new Map();
    // Prefer a country's own file over a file it shares with its neighbours.
    const ordered = [...(catalog?.entries ?? [])].sort(
      (a, b) => a.codes.length - b.codes.length,
    );
    for (const entry of ordered)
      for (const code of entry.codes)
        if (!offers.has(code)) offers.set(code, entry);
    return offers;
  }

  const fitsOnDisk = (bytes, computer) =>
    !bytes || bytes <= computer.freeDiskBytes - DISK_RESERVE;

  function startDownload(code, res) {
    const offer = currentOffers().get(code);
    if (!offer)
      return json(res, 404, { error: "This country has no download." });
    const bytes = catalog.files[offer.pbf]?.bytes;
    if (!fitsOnDisk(bytes, machine()))
      return json(res, 409, { error: "There isn't enough free disk space." });
    const slug = extractSlug(offer.pbf);
    downloads.start({
      code,
      name: offer.name,
      slug,
      url: offer.pbf,
      totalBytes: bytes,
    });
    return json(res, 202, { download: downloads.view(slug) });
  }

  async function controlDownload(code, action, res) {
    const offer = currentOffers().get(code);
    if (!offer)
      return json(res, 404, { error: "This country has no download." });
    const slug = extractSlug(offer.pbf);
    if (action === "pause") downloads.pause(slug);
    else await downloads.stop(slug);
    return json(res, 200, { download: downloads.view(slug) });
  }

  function startBuild(code, res) {
    const offer = currentOffers().get(code);
    if (!offer)
      return json(res, 404, { error: "This country has no download." });
    const slug = extractSlug(offer.pbf);
    const found = downloadedFile(slug);
    if (!found)
      return json(res, 409, { error: "Download this country first." });
    if (downloads.isDownloading(slug))
      return json(res, 409, { error: "Wait for the download to finish." });
    const estimate = estimateBuild(found.info.size, machine(), true);
    if (!estimate.fits)
      return json(res, 409, { error: "This country is too large to build here." });
    builds.start({
      code,
      name: names.of(code) ?? code,
      pbf: found.file,
      source: offer.pbf.replace(FILE_SUFFIX, ".html"),
      expectedSeconds: estimate.seconds,
    });
    return json(res, 202, { build: builds.view(code) });
  }

  function status() {
    const computer = machine();
    const offers = currentOffers();

    const countries = [...new Set([...COUNTRY_CODES, ...offers.keys()])].map(
      (code) => {
        const offer = offers.get(code);
        const file = offer ? catalog.files[offer.pbf] : null;
        const website = offer
          ? {
              name: offer.name,
              continent: offer.continent,
              shared: offer.codes.length > 1,
              bytes: file?.bytes ?? null,
              modifiedMs: file?.modifiedMs ?? null,
            }
          : null;
        const slug = offer ? extractSlug(offer.pbf) : null;
        const downloaded = slug ? downloadedInfo(slug) : null;
        const app = databaseInfo(code);
        const updateAvailable = Boolean(
          downloaded &&
            website?.modifiedMs &&
            website.modifiedMs > downloaded.modifiedMs,
        );
        const estimate = estimateBuild(
          website?.bytes ?? downloaded?.bytes,
          computer,
          Boolean(downloaded),
        );
        return {
          code,
          name: names.of(code) ?? code,
          website,
          downloaded,
          app,
          updateAvailable,
          estimate,
          download: slug ? downloads.view(slug) : null,
          downloadFits: fitsOnDisk(website?.bytes, computer),
          build: builds.view(code),
          canBuild: Boolean(
            downloaded && estimate?.fits && !downloads.isDownloading(slug),
          ),
          nextStep: nextStep({
            website,
            downloaded,
            app,
            updateAvailable,
            estimate,
          }),
        };
      },
    );
    countries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return {
      catalog: {
        loaded: Boolean(catalog),
        checkedMs: catalog?.checkedMs ?? null,
        checking: Boolean(progress.running),
        done: progress.done,
        total: progress.total,
        error: progress.error,
      },
      downloads: {
        active: downloads.isBusy(),
        jobs: downloads.jobs(),
        log: downloads.log(),
      },
      builds: { active: builds.isBusy(), jobs: builds.jobs() },
      machine: computer,
      countries,
    };
  }

  return {
    status,
    refreshIfStale,
    whenIdle: () => progress.running ?? Promise.resolve(),
    whenDownloadsIdle: () => downloads.whenIdle(),
    whenBuildsIdle: () => builds.whenIdle(),
    shutdown: () => builds.stopAll(),
    serve(req, res, url) {
      if (url.pathname === "/api/countries") {
        if (req.method !== "GET")
          return json(res, 405, { error: "Method not allowed." });
        refreshIfStale();
        return json(res, 200, status());
      }
      const action =
        /^\/api\/countries\/([A-Z]{2})\/(download|build)(?:\/(pause|stop))?$/.exec(
          url.pathname,
        );
      if (!action) return json(res, 404, { error: "Endpoint not found." });
      if (req.method !== "POST")
        return json(res, 405, { error: "Method not allowed." });
      if (!isOwnPageRequest(req))
        return json(res, 403, { error: "This request isn't from this app." });
      const [, code, kind, control] = action;
      if (kind === "build") {
        if (control === "pause")
          return json(res, 404, { error: "Endpoint not found." });
        if (!control) return startBuild(code, res);
        builds.stop(code);
        return json(res, 200, { build: builds.view(code) });
      }
      return control
        ? controlDownload(code, control, res)
        : startDownload(code, res);
    },
  };
}
