import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { createBrotliCompress, createGzip, constants } from "node:zlib";
import { serveAnalytics } from "./analytics.mjs";
import { createCountryService } from "./countries.mjs";
import { logError, logRequests } from "./log.mjs";
import { chooseEncoding, createQueryPool } from "./query-pool.mjs";
import { clientAddress, createRateLimiter } from "./rate-limit.mjs";
import {
  analyticsDir,
  imageryDir,
  inputDir,
  outputDir,
  webDist,
  webRoot,
} from "./paths.mjs";

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) ? value : fallback;
};

const port = number("PORT", 5173);
const host = process.env.HOST || "127.0.0.1";
const production = process.env.NODE_ENV === "production";
// On a public site, nobody may trigger downloads or database builds.
const publicSite = process.env.WAYFINDER_PUBLIC === "1";
const trustedProxies = number("WAYFINDER_TRUSTED_PROXIES", 0);

// Vite is a development dependency, so production must not load it.
const vite = production
  ? null
  : await (await import("vite")).createServer({
      root: webRoot,
      server: {
        middlewareMode: true,
        hmr: { port: port + 1, host: "127.0.0.1" },
      },
      appType: "spa",
    });

const queries = createQueryPool({
  analyticsDir,
  imageryDir,
  timeoutMs: number("WAYFINDER_QUERY_TIMEOUT_MS", 15_000),
  queueLimit: number("WAYFINDER_QUEUE_LIMIT", 100),
});
const countries = publicSite
  ? null
  : createCountryService({
      inputDir,
      analyticsDir,
      cacheDir: path.join(outputDir, "cache/countries"),
    });
const limiter = publicSite
  ? createRateLimiter({
      perSecond: number("WAYFINDER_RATE_PER_SECOND", 5),
      burst: number("WAYFINDER_RATE_BURST", 60),
    })
  : null;

function jsonError(res, status, error, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify({ error }));
}

function serveJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function serveHealth(res) {
  let databases = 0;
  try {
    databases = fs
      .readdirSync(analyticsDir)
      .filter((name) => /^[A-Z]{2}\.sqlite$/.test(name)).length;
  } catch {
    // A missing folder is the same as no databases.
  }
  const stats = queries.stats();
  serveJson(res, databases && stats.workers ? 200 : 503, {
    status: databases && stats.workers ? "ok" : "unavailable",
    databases,
    ...stats,
  });
}

// PMTiles readers fetch byte ranges, so the file needs no tile server.
function serveTiles(req, res, url) {
  const name = /^\/tiles\/([A-Z]{2}\.pmtiles)$/.exec(url.pathname)?.[1];
  let info;
  try {
    info = name && fs.statSync(path.join(analyticsDir, name));
  } catch {
    info = null;
  }
  if (!info) {
    res.writeHead(404);
    return res.end();
  }
  const headers = {
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    ETag: '"' + info.size + "-" + Math.round(info.mtimeMs) + '"',
    "Cache-Control": url.searchParams.has("v")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = Math.min(
    range?.[2] ? Number(range[2]) : info.size - 1,
    info.size - 1,
  );
  if (range && start > end) {
    res.writeHead(416, { "Content-Range": "bytes */" + info.size });
    return res.end();
  }
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "Content-Length": String(end - start + 1),
    ...(range && { "Content-Range": `bytes ${start}-${end}/${info.size}` }),
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(path.join(analyticsDir, name), {
    start,
    end,
  });
  stream.once("error", (error) => {
    logError("tiles", error, { path: url.pathname });
    res.destroy();
  });
  stream.pipe(res);
}

function serveStatic(req, res, url) {
  let requested;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const candidate = path.resolve(webDist, `.${requested}`);
  const indexFile = path.join(webDist, "index.html");
  const file =
    candidate.startsWith(`${webDist}${path.sep}`) &&
    fs.existsSync(candidate) &&
    fs.statSync(candidate).isFile()
      ? candidate
      : indexFile;
  const types = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  if (!fs.existsSync(file)) {
    res.writeHead(503);
    res.end("Run npm run build first.");
    return;
  }
  const stream = fs.createReadStream(file);
  // A deploy can remove a file between the check above and this read.
  stream.once("error", (error) => {
    logError("static-file", error, { path: url.pathname });
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(503);
      res.end();
    }
  });
  stream.once("open", () => {
    const extension = path.extname(file);
    // Vite puts a content hash in these names, so they never change.
    const hashed = url.pathname.startsWith("/assets/") && file !== indexFile;
    const headers = {
      "Content-Type": types[extension] || "application/octet-stream",
      "Cache-Control": hashed
        ? "public, max-age=31536000, immutable"
        : extension === ".html"
          ? "no-cache"
          : "public, max-age=3600",
      Vary: "Accept-Encoding",
    };
    const encoding = extension in types && chooseEncoding(req.headers["accept-encoding"]);
    if (!encoding) {
      res.writeHead(200, headers);
      return stream.pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Encoding": encoding });
    const compress =
      encoding === "br"
        ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
        : createGzip();
    pipeline(stream, compress, res, () => {});
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return jsonError(res, 400, "Invalid request path.");
  }
  if (production) logRequests(req, res, url.pathname);
  if (url.pathname === "/api/health") return serveHealth(res);
  if (url.pathname === "/api/config")
    return serveJson(res, 200, { publicSite });
  if (limiter && url.pathname.startsWith("/api/")) {
    const retry = limiter.check(clientAddress(req, trustedProxies));
    if (retry)
      return jsonError(res, 429, "Too many requests. Try again shortly.", {
        "Retry-After": String(retry),
      });
  }
  if (
    url.pathname === "/api/analytics" ||
    url.pathname.startsWith("/api/analytics/")
  ) {
    try {
      // Imagery is network work, so only database queries go to the workers.
      if (url.pathname.includes("/imagery/"))
        await serveAnalytics(req, res, url, { analyticsDir, imageryDir });
      else await queries.handle(req, res, url);
    } catch (error) {
      logError("analytics", error, { path: url.pathname });
      if (!res.headersSent)
        jsonError(res, 503, "The analytics service could not load this request.");
      else res.destroy();
    }
    return;
  }
  if (
    countries &&
    (url.pathname === "/api/countries" ||
      url.pathname.startsWith("/api/countries/"))
  ) {
    try {
      await countries.serve(req, res, url);
    } catch (error) {
      logError("countries", error, { path: url.pathname });
      if (!res.headersSent)
        jsonError(res, 503, "The country list could not be loaded.");
      else res.destroy();
    }
    return;
  }
  if (url.pathname.startsWith("/api/"))
    return jsonError(res, 404, "Endpoint not found.");
  if (url.pathname.startsWith("/tiles/")) return serveTiles(req, res, url);
  if (publicSite && url.pathname.replace(/\/+$/, "") === "/countries") {
    res.writeHead(302, { Location: "/" });
    return res.end();
  }
  if (vite) return vite.middlewares(req, res);
  serveStatic(req, res, url);
});

server.on("error", (error) => {
  logError("server", error);
  process.exit(1);
});
server.listen(port, host, () =>
  console.log(`
  Wayfinder Analytics → http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${port}${publicSite ? " (public mode)" : ""}
`),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  countries?.shutdown();
  await queries.close();
  server.close();
  await vite?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
