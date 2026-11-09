import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createCountryService,
  estimateBuild,
  extractSlug,
  nextStep,
  parseCatalog,
} from "../../server/countries.mjs";

const base = "https://download.geofabrik.de/";
const feature = (id, parent, codes, file = id) => ({
  properties: {
    id,
    name: id.toUpperCase(),
    ...(parent ? { parent } : {}),
    ...(codes ? { "iso3166-1:alpha2": codes } : {}),
    urls: { pbf: base + file + "-latest.osm.pbf" },
  },
});
const index = {
  features: [
    feature("europe", null, null),
    feature("luxembourg", "europe", ["LU"]),
    feature("malta", "europe", ["MT"]),
    feature("germany", "europe", ["DE"]),
    feature("oceania", null, null),
    feature("tokelau", "oceania", ["VU"]),
    feature("vanuatu", "oceania", ["VU"]),
    feature("gcc-states", "oceania", ["QA"]),
    feature("kosovo", "europe", null),
  ],
};
const MB = 1e6;
const GB = 1e9;
const sizes = {
  "luxembourg-latest.osm.pbf": 46 * MB,
  "malta-latest.osm.pbf": 9 * MB,
  "germany-latest.osm.pbf": 4.5 * GB,
};
const modified = "Sun, 08 Nov 2026 00:52:08 GMT";
const modifiedMs = Date.parse(modified);
const roomy = { memoryBytes: 24 * 1024 ** 3, freeDiskBytes: 99 * 1024 ** 3 };

function fakeSite(log = []) {
  return async (url, options = {}) => {
    log.push([options.method ?? "GET", url]);
    if (url.endsWith("index-v1-nogeom.json"))
      return new Response(JSON.stringify(index));
    const bytes = sizes[url.split("/").pop()] ?? MB;
    return new Response(null, {
      headers: { "content-length": String(bytes), "last-modified": modified },
    });
  };
}

function directories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayfinder-countries-"));
  const inputDir = path.join(root, "input");
  const analyticsDir = path.join(root, "analytics");
  fs.mkdirSync(path.join(inputDir, "osm"), { recursive: true });
  fs.mkdirSync(analyticsDir);
  return { inputDir, analyticsDir, cacheDir: path.join(root, "cache") };
}

function addExtract(dirs, name, modifiedAt) {
  const file = path.join(dirs.inputDir, "osm", name);
  fs.writeFileSync(file, "x");
  fs.utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
}

function addDatabase(dirs, code, snapshot, builtAt) {
  const file = path.join(dirs.analyticsDir, code + ".sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE metadata (summary TEXT NOT NULL)");
  db.prepare("INSERT INTO metadata VALUES (?)").run(JSON.stringify({ snapshot }));
  db.close();
  fs.utimesSync(file, builtAt / 1000, builtAt / 1000);
}

async function loaded(dirs, fetchImpl = fakeSite(), now = Date.now) {
  const service = createCountryService({
    ...dirs,
    fetchImpl,
    now,
    machine: () => roomy,
  });
  service.refreshIfStale();
  await service.whenIdle();
  return service;
}

const row = (service, code) =>
  service.status().countries.find((country) => country.code === code);

test("only real extract URLs produce a file name", () => {
  assert.equal(extractSlug(base + "europe/luxembourg-latest.osm.pbf"), "luxembourg");
  for (const bad of [
    "https://evil.example/europe/luxembourg-latest.osm.pbf",
    "http://download.geofabrik.de/luxembourg-latest.osm.pbf",
    base + "..%2F..%2Fsecret-latest.osm.pbf",
    base + "luxembourg.osm.bz2",
    "not a url",
    undefined,
  ])
    assert.equal(extractSlug(bad), null, String(bad));
});

test("the catalog's wrong and missing country codes are corrected", () => {
  const entries = parseCatalog(index);
  const codes = Object.fromEntries(entries.map((e) => [e.id, e.codes]));
  assert.deepEqual(codes.tokelau, ["TK"]);
  assert.deepEqual(codes.vanuatu, ["VU"]);
  assert.deepEqual(codes.kosovo, ["XK"]);
  assert.ok(codes["gcc-states"].includes("SA"));
  assert.equal(codes.europe, undefined);
  assert.equal(
    entries.find((e) => e.id === "luxembourg").continent,
    "EUROPE",
  );
});

test("build estimates follow the measured Austria ratios and the machine's limits", () => {
  const austria = estimateBuild(814.85 * MB, roomy);
  assert.equal(austria.fits, true);
  assert.equal(austria.seconds, 1160);
  assert.equal(austria.memoryBytes, 5077 * MB);
  // China's 1.6 GB extract used to be refused by the old estimate.
  assert.equal(estimateBuild(1.6 * GB, roomy).fits, true);
  const germany = estimateBuild(4.5 * GB, roomy);
  assert.equal(germany.fits, false);
  assert.equal(germany.limit, "memory");
  const noDisk = estimateBuild(GB, {
    memoryBytes: roomy.memoryBytes,
    freeDiskBytes: 12 * 1024 ** 3,
  });
  assert.equal(noDisk.limit, "disk");
  assert.equal(estimateBuild(null, roomy), null);
});

test("next step reflects website, download and app state", () => {
  const website = { bytes: MB };
  const estimate = { fits: true };
  const downloaded = { modifiedMs: 100 };
  const app = { builtMs: 200 };
  const step = (state) => nextStep({ website, estimate, ...state });
  assert.equal(step({ website: null }), "unavailable");
  assert.equal(step({}), "download-and-build");
  assert.equal(step({ downloaded }), "build");
  assert.equal(step({ downloaded, app }), "up-to-date");
  assert.equal(step({ downloaded, app, updateAvailable: true }), "refresh");
  assert.equal(step({ downloaded: { modifiedMs: 300 }, app }), "build");
  assert.equal(step({ app }), "refresh");
  assert.equal(step({ estimate: { fits: false } }), "too-large");
});

test("each country shows website, download and app status", async () => {
  const dirs = directories();
  addExtract(dirs, "luxembourg.osm.pbf", modifiedMs + 60_000);
  addExtract(dirs, "malta-latest.osm.pbf", modifiedMs - 60_000);
  addDatabase(dirs, "LU", "2026-11-07T21:21:36Z", modifiedMs + 120_000);
  const service = await loaded(dirs);

  const lu = row(service, "LU");
  assert.equal(lu.name, "Luxembourg");
  assert.equal(lu.website.bytes, 46 * MB);
  assert.ok(lu.downloaded);
  assert.equal(lu.app.snapshot, "2026-11-07T21:21:36Z");
  assert.equal(lu.nextStep, "up-to-date");

  const mt = row(service, "MT");
  assert.equal(mt.updateAvailable, true);
  assert.equal(mt.app, null);
  assert.equal(mt.nextStep, "build");

  assert.equal(row(service, "DE").nextStep, "too-large");
  assert.equal(row(service, "VU").website.name, "VANUATU");
  assert.equal(row(service, "SA").website.shared, true);
  assert.equal(row(service, "BB").nextStep, "unavailable");
});

test("an unreadable database is reported, not fatal", async () => {
  const dirs = directories();
  fs.writeFileSync(path.join(dirs.analyticsDir, "LU.sqlite"), "not a database");
  const service = await loaded(dirs);
  assert.equal(row(service, "LU").app.unreadable, true);
});

test("the catalog is checked once a day, and the cache survives a restart", async () => {
  const dirs = directories();
  const log = [];
  let time = modifiedMs;
  const service = await loaded(dirs, fakeSite(log), () => time);
  const firstRun = log.length;
  assert.ok(firstRun > 1);

  time += 60 * 60 * 1000;
  service.refreshIfStale();
  await service.whenIdle();
  assert.equal(log.length, firstRun);

  const restarted = await loaded(dirs, fakeSite(log), () => time);
  assert.equal(log.length, firstRun);
  assert.equal(row(restarted, "LU").website.bytes, 46 * MB);

  time += 24 * 60 * 60 * 1000;
  service.refreshIfStale();
  await service.whenIdle();
  assert.ok(log.length > firstRun);
});

test("when the website is unreachable, local status still works", async () => {
  const dirs = directories();
  addDatabase(dirs, "LU", "2026-11-07T21:21:36Z", modifiedMs);
  const offline = async () => {
    throw new Error("network down");
  };
  const service = await loaded(dirs, offline);
  const status = service.status();
  assert.equal(status.catalog.loaded, false);
  assert.equal(status.catalog.error, "network down");
  assert.ok(status.countries.length >= 250);
  assert.ok(row(service, "LU").app);
});

test("a failed check keeps the last good catalog", async () => {
  const dirs = directories();
  let time = modifiedMs;
  const site = fakeSite();
  let online = true;
  const service = await loaded(
    dirs,
    (...args) => {
      if (!online) throw new Error("network down");
      return site(...args);
    },
    () => time,
  );
  online = false;
  time += 25 * 60 * 60 * 1000;
  service.refreshIfStale();
  await service.whenIdle();
  const status = service.status();
  assert.equal(status.catalog.error, "network down");
  assert.equal(row(service, "LU").website.bytes, 46 * MB);
});

function call(service, method, pathname, headers = {}) {
  const reply = {};
  reply.done = null;
  const res = {
    writeHead: (status) => (reply.status = status),
    end: (body) => (reply.body = JSON.parse(body)),
  };
  reply.done = service.serve(
    { method, headers },
    res,
    new URL(pathname, "http://localhost"),
  );
  return reply;
}
const ownPage = { host: "localhost:5173", origin: "http://localhost:5173" };

// Serves the fake catalog and real bytes for one extract.
function siteWithFile(bytes, overrides = {}) {
  const base = fakeSite();
  const checksum = createHash("md5").update(bytes).digest("hex");
  const calls = [];
  const site = async (url, options = {}) => {
    calls.push(url);
    if (url.endsWith(".osm.pbf.md5"))
      return new Response(overrides.checksum ?? checksum + "  file.osm.pbf\n");
    if (url.endsWith(".osm.pbf") && options.method !== "HEAD")
      return overrides.body
        ? overrides.body(options)
        : new Response(bytes, {
            headers: { "content-length": String(bytes.length) },
          });
    return base(url, options);
  };
  site.calls = calls;
  return site;
}

const extractPath = (dirs, slug) =>
  path.join(dirs.inputDir, "osm", slug + ".osm.pbf");
const partFiles = (dirs) =>
  fs
    .readdirSync(path.join(dirs.inputDir, "osm"))
    .filter((name) => name.endsWith(".part"));

test("the status endpoint refuses anything but GET", async () => {
  const service = await loaded(directories());
  assert.equal(call(service, "POST", "/api/countries").status, 405);
});

test("downloads only start from this app's own page", async () => {
  const service = await loaded(directories(), siteWithFile(Buffer.from("x")));
  const path = "/api/countries/MT/download";
  for (const headers of [
    {},
    { host: "localhost:5173" },
    { host: "localhost:5173", origin: "https://evil.example" },
    { host: "localhost:5173", origin: "http://localhost:9999" },
    { host: "evil.example", origin: "http://evil.example" },
  ])
    assert.equal(call(service, "POST", path, headers).status, 403);
  assert.equal(call(service, "GET", path, ownPage).status, 405);
  assert.equal(service.status().downloads.active, false);
});

test("a verified download gets its final name and updates the country", async () => {
  const dirs = directories();
  const bytes = Buffer.from("verified extract");
  const service = await loaded(dirs, siteWithFile(bytes));
  assert.equal(
    call(service, "POST", "/api/countries/MT/download", ownPage).status,
    202,
  );
  await service.whenDownloadsIdle();
  assert.deepEqual(fs.readFileSync(extractPath(dirs, "malta")), bytes);
  assert.deepEqual(partFiles(dirs), []);
  const mt = row(service, "MT");
  assert.equal(mt.download.state, "done");
  assert.equal(mt.downloaded.bytes, bytes.length);
  assert.equal(mt.nextStep, "build");
});

test("a checksum mismatch keeps the existing file", async () => {
  const dirs = directories();
  addExtract(dirs, "malta.osm.pbf", modifiedMs);
  const site = siteWithFile(Buffer.from("corrupted"), {
    checksum: "0".repeat(32),
  });
  const service = await loaded(dirs, site);
  call(service, "POST", "/api/countries/MT/download", ownPage);
  await service.whenDownloadsIdle();
  assert.equal(fs.readFileSync(extractPath(dirs, "malta"), "utf8"), "x");
  assert.deepEqual(partFiles(dirs), []);
  const { download } = row(service, "MT");
  assert.equal(download.state, "failed");
  assert.match(download.error, /checksum/);
});

test("an unchanged file is not downloaded again", async () => {
  const dirs = directories();
  const bytes = Buffer.from("same data");
  fs.writeFileSync(extractPath(dirs, "malta"), bytes);
  const old = modifiedMs - 86_400_000;
  fs.utimesSync(extractPath(dirs, "malta"), old / 1000, old / 1000);
  const site = siteWithFile(bytes);
  sizes["malta-latest.osm.pbf"] = bytes.length;
  try {
    const service = await loaded(dirs, site);
    assert.equal(row(service, "MT").updateAvailable, true);
    site.calls.length = 0;
    call(service, "POST", "/api/countries/MT/download", ownPage);
    await service.whenDownloadsIdle();
    assert.equal(site.calls.filter((u) => u.endsWith(".pbf")).length, 0);
    assert.equal(row(service, "MT").download.state, "done");
    assert.equal(row(service, "MT").updateAvailable, false);
  } finally {
    sizes["malta-latest.osm.pbf"] = 9 * MB;
  }
});

// A response that sends one chunk, then stays open until the request aborts.
const hangingBody = ({ signal }) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        signal.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted", "AbortError")),
        );
      },
    }),
  );

test("cancelling stops the download and leaves nothing behind", async () => {
  const dirs = directories();
  const service = await loaded(
    dirs,
    siteWithFile(Buffer.from("x"), { body: hangingBody }),
  );
  call(service, "POST", "/api/countries/MT/download", ownPage);
  while (row(service, "MT").download.receivedBytes === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.status().downloads.active, true);
  call(service, "POST", "/api/countries/MT/download/stop", ownPage);
  await service.whenDownloadsIdle();
  assert.equal(row(service, "MT").download.state, "cancelled");
  assert.equal(fs.existsSync(extractPath(dirs, "malta")), false);
  assert.deepEqual(partFiles(dirs), []);
});

test("a stalled download fails and keeps its partial file to continue", async () => {
  const dirs = directories();
  const service = createCountryService({
    ...dirs,
    fetchImpl: siteWithFile(Buffer.from("x"), { body: hangingBody }),
    machine: () => roomy,
    stallMs: 20,
  });
  service.refreshIfStale();
  await service.whenIdle();
  call(service, "POST", "/api/countries/MT/download", ownPage);
  await service.whenDownloadsIdle();
  const { download } = row(service, "MT");
  assert.equal(download.state, "failed");
  assert.match(download.error, /stalled/);
  assert.equal(partFiles(dirs).length, 1);
});

// First request sends part of the file and hangs. Later ones honour Range.
function resumableSite(bytes, { honourRange = true } = {}) {
  const requests = [];
  const site = siteWithFile(bytes, {
    body: ({ signal, headers }) => {
      requests.push(headers.Range ?? null);
      if (requests.length === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes.subarray(0, 7)));
              signal.addEventListener("abort", () =>
                controller.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
          { headers: { "content-length": String(bytes.length) } },
        );
      const offset = Number(/\d+/.exec(headers.Range ?? "0")[0]);
      if (!honourRange || !offset) return new Response(bytes);
      return new Response(bytes.subarray(offset), {
        status: 206,
        headers: {
          "content-range":
            "bytes " + offset + "-" + (bytes.length - 1) + "/" + bytes.length,
        },
      });
    },
  });
  site.requests = requests;
  return site;
}

async function pausedDownload(dirs, site) {
  const service = await loaded(dirs, site);
  call(service, "POST", "/api/countries/MT/download", ownPage);
  while (!row(service, "MT").download?.receivedBytes)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await call(service, "POST", "/api/countries/MT/download/pause", ownPage).done;
  await service.whenDownloadsIdle();
  return service;
}

test("pause keeps the partial file and resume continues from it", async () => {
  const dirs = directories();
  const bytes = Buffer.from("partial and the rest of the extract");
  const site = resumableSite(bytes);
  const service = await pausedDownload(dirs, site);

  const paused = row(service, "MT").download;
  assert.equal(paused.state, "paused");
  assert.equal(paused.receivedBytes, 7);
  assert.equal(partFiles(dirs).length, 1);
  assert.equal(service.status().downloads.active, false);
  assert.equal(service.status().downloads.jobs.length, 1);
  assert.equal(fs.existsSync(extractPath(dirs, "malta")), false);

  call(service, "POST", "/api/countries/MT/download", ownPage);
  await service.whenDownloadsIdle();
  assert.deepEqual(site.requests, [null, "bytes=7-"]);
  assert.deepEqual(fs.readFileSync(extractPath(dirs, "malta")), bytes);
  assert.deepEqual(partFiles(dirs), []);
  assert.equal(row(service, "MT").download.state, "done");
  assert.equal(service.status().downloads.jobs.length, 0);
  const messages = service.status().downloads.log.map((entry) => entry.text);
  assert.ok(messages.some((text) => text.startsWith("Paused at")));
  assert.ok(messages.some((text) => text.startsWith("Resuming from")));
  assert.ok(messages.some((text) => text.startsWith("Verified and saved")));
});

test("resume starts over cleanly if the website ignores the range", async () => {
  const dirs = directories();
  const bytes = Buffer.from("partial and the rest of the extract");
  const service = await pausedDownload(
    dirs,
    resumableSite(bytes, { honourRange: false }),
  );
  call(service, "POST", "/api/countries/MT/download", ownPage);
  await service.whenDownloadsIdle();
  assert.deepEqual(fs.readFileSync(extractPath(dirs, "malta")), bytes);
  assert.equal(row(service, "MT").download.state, "done");
});

test("stopping a paused download removes its partial file", async () => {
  const dirs = directories();
  const service = await pausedDownload(
    dirs,
    resumableSite(Buffer.from("partial and more")),
  );
  await call(service, "POST", "/api/countries/MT/download/stop", ownPage).done;
  assert.equal(row(service, "MT").download.state, "cancelled");
  assert.deepEqual(partFiles(dirs), []);
});

test("downloads run one at a time and can be queued", async () => {
  const dirs = directories();
  const service = await loaded(
    dirs,
    siteWithFile(Buffer.from("x"), { body: hangingBody }),
  );
  call(service, "POST", "/api/countries/MT/download", ownPage);
  call(service, "POST", "/api/countries/LU/download", ownPage);
  while (row(service, "MT").download.receivedBytes === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(row(service, "LU").download.state, "queued");
  call(service, "POST", "/api/countries/LU/download/stop", ownPage);
  assert.equal(row(service, "LU").download.state, "cancelled");
  call(service, "POST", "/api/countries/MT/download/stop", ownPage);
  await service.whenDownloadsIdle();
  assert.equal(service.status().downloads.active, false);
});

test("a download that can't fit on disk is refused", async () => {
  const dirs = directories();
  const service = createCountryService({
    ...dirs,
    fetchImpl: fakeSite(),
    machine: () => ({ memoryBytes: roomy.memoryBytes, freeDiskBytes: 11e9 }),
  });
  service.refreshIfStale();
  await service.whenIdle();
  assert.equal(row(service, "DE").downloadFits, false);
  assert.equal(
    call(service, "POST", "/api/countries/DE/download", ownPage).status,
    409,
  );
  assert.equal(service.status().downloads.active, false);
});

test("a country without a download can't start one", async () => {
  const service = await loaded(directories());
  assert.equal(
    call(service, "POST", "/api/countries/BB/download", ownPage).status,
    404,
  );
});
