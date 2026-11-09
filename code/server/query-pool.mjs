// Sends analytics requests to worker threads so a slow query can't freeze the
// server. One worker is always kept free of heavy queries, so quick requests
// still get answered while the others are busy.
import { statSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

const POOL_SIZE = 4;
const MAX_BODY_BYTES = 128 * 1024;
const CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
const CACHE_ENTRY_LIMIT_BYTES = 8 * 1024 * 1024;
const CACHE_MIN_MS = 150;
const QUERY_TIMEOUT_MS = 15_000;
const QUEUE_LIMIT = 100;
// Long enough that a quick query finishes rather than costing a new worker.
const ABANDON_GRACE_MS = 250;

const heavyRequest = /^\/api\/analytics\/[A-Z]{2}\/(features|selection|freshness|tag-regions|nearby)$/;
const cacheableRequest =
  /^\/api\/analytics\/([A-Z]{2})\/(features|selection|freshness|tag-regions|nearby|tags)$/;

const compressible = /json|csv/;

export function chooseEncoding(accepted = "") {
  const offered = accepted.split(",").map((part) => part.trim().split(";"));
  const allowed = (name) =>
    offered.some(([coding, q]) => coding === name && q?.trim() !== "q=0");
  return allowed("br") ? "br" : allowed("gzip") ? "gzip" : null;
}

const compressor = (encoding) =>
  encoding === "br"
    ? createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      })
    : createGzip({ level: 5 });

export function createQueryPool({
  analyticsDir,
  imageryDir,
  size = POOL_SIZE,
  workerUrl = new URL("./query-worker.mjs", import.meta.url),
  cacheBytes = CACHE_LIMIT_BYTES,
  cacheMinMs = CACHE_MIN_MS,
  timeoutMs = QUERY_TIMEOUT_MS,
  queueLimit = QUEUE_LIMIT,
  abandonGraceMs = ABANDON_GRACE_MS,
}) {
  const slots = [];
  const queue = [];
  const cache = new Map();
  let cachedBytes = 0;
  let nextId = 0;
  let closing = false;

  function databaseIdentity(country) {
    try {
      const { ino, mtimeMs, size: bytes } = statSync(
        path.join(analyticsDir, country + ".sqlite"),
      );
      return ino + ":" + mtimeMs + ":" + bytes;
    } catch {
      return null;
    }
  }

  function cacheKey(job) {
    const match = cacheableRequest.exec(job.pathname);
    if (!match || new URLSearchParams(job.search).get("format") === "csv")
      return null;
    const identity = databaseIdentity(match[1]);
    if (!identity) return null;
    return [
      identity,
      job.encoding,
      job.method,
      job.pathname,
      job.search,
      job.bodyText,
    ].join("\n");
  }

  function remember(key, entry) {
    if (entry.bytes > CACHE_ENTRY_LIMIT_BYTES || entry.bytes > cacheBytes) return;
    cache.set(key, entry);
    cachedBytes += entry.bytes;
    for (const [oldest, old] of cache) {
      if (cachedBytes <= cacheBytes) break;
      cache.delete(oldest);
      cachedBytes -= old.bytes;
    }
  }

  function replyFromCache(key, res) {
    const entry = cache.get(key);
    if (!entry) return false;
    // Reinserting moves it to the newest position.
    cache.delete(key);
    cache.set(key, entry);
    res.writeHead(entry.status, entry.headers);
    res.end(entry.body);
    return true;
  }

  function clearTimers(job) {
    clearTimeout(job.deadline);
    clearTimeout(job.grace);
  }

  function finishSlot(slot) {
    if (slot.job) clearTimers(slot.job);
    slot.job = null;
    pump();
  }

  function refuse(res, status, error, headers = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify({ error }));
  }

  function failJob(
    job,
    status = 503,
    message = "The analytics service could not load this request.",
  ) {
    clearTimers(job);
    if (job.abandoned || job.answered) return;
    job.answered = true;
    if (!job.res.headersSent) refuse(job.res, status, message);
    else job.res.destroy();
  }

  // node:sqlite can't interrupt a running statement, so the worker has to go.
  // Its exit handler starts the replacement.
  function stopWorker(slot) {
    if (slot.stopping) return;
    slot.stopping = true;
    slot.worker.terminate();
  }

  function onMessage(slot, message) {
    const job = slot.job;
    if (!job || message.id !== job.id || job.answered) return;
    if (message.type === "head") startReply(job, message);
    else if (message.type === "chunk") {
      const data = Buffer.from(message.data);
      if (job.compressing) job.compressing.write(data);
      else sendChunk(job, data);
    } else if (message.type === "end") {
      if (job.compressing) job.compressing.end();
      else endReply(job);
      finishSlot(slot);
    } else {
      job.compressing?.destroy();
      failJob(job);
      finishSlot(slot);
    }
  }

  function startReply(job, { status, headers }) {
    job.status = status;
    job.headers = { ...headers, Vary: "Accept-Encoding" };
    const type = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    if (job.encoding && compressible.test(type ?? "")) {
      job.headers["Content-Encoding"] = job.encoding;
      job.compressing = compressor(job.encoding);
      job.compressing.on("data", (data) => sendChunk(job, data));
      job.compressing.on("end", () => endReply(job));
      job.compressing.on("error", () => job.res.destroy());
    }
    if (!job.abandoned) job.res.writeHead(status, job.headers);
  }

  function sendChunk(job, data) {
    if (!job.abandoned) job.res.write(data);
    job.bytes += data.length;
    if (job.key && job.bytes <= CACHE_ENTRY_LIMIT_BYTES) job.chunks.push(data);
  }

  function endReply(job) {
    if (!job.abandoned) job.res.end();
    if (
      job.key &&
      job.status === 200 &&
      job.bytes <= CACHE_ENTRY_LIMIT_BYTES &&
      Date.now() - job.startedMs >= cacheMinMs
    )
      remember(job.key, {
        status: job.status,
        headers: job.headers,
        body: Buffer.concat(job.chunks, job.bytes),
        bytes: job.bytes,
      });
  }

  function addSlot(index) {
    const worker = new Worker(workerUrl, {
      workerData: { analyticsDir, imageryDir },
    });
    const slot = { worker, job: null, stopping: false };
    slots[index] = slot;
    worker.on("message", (message) => onMessage(slot, message));
    const replace = () => {
      if (slots[index] !== slot || closing) return;
      if (slot.job) failJob(slot.job);
      slot.job = null;
      addSlot(index);
      pump();
    };
    worker.on("error", (error) => {
      console.error(error);
      replace();
    });
    worker.on("exit", replace);
  }

  for (let index = 0; index < size; index++) addSlot(index);

  function pump() {
    while (queue.length) {
      const idle = slots.find((slot) => !slot.job && !slot.stopping);
      if (!idle) return;
      const heavyRunning = slots.filter((slot) => slot.job?.heavy).length;
      const canRunHeavy = heavyRunning < Math.max(1, size - 1);
      const position = queue.findIndex((job) => !job.heavy || canRunHeavy);
      if (position < 0) return;
      const [job] = queue.splice(position, 1);
      job.startedMs = Date.now();
      idle.job = job;
      job.slot = idle;
      job.deadline = setTimeout(() => {
        failJob(job, 504, "This query took too long. Try a smaller selection.");
        stopWorker(idle);
      }, timeoutMs);
      idle.worker.postMessage({
        id: job.id,
        method: job.method,
        path: job.pathname + job.search,
        body: job.body,
      });
    }
  }

  async function readBody(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      // One byte over the limit is enough for the handler to refuse it.
      if (length <= MAX_BODY_BYTES) chunks.push(chunk);
      length += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES + 1);
  }

  return {
    async handle(req, res, url) {
      const body = req.method === "POST" ? await readBody(req) : null;
      const job = {
        id: ++nextId,
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        body,
        bodyText: body ? body.toString("utf8") : "",
        heavy: heavyRequest.test(url.pathname),
        res,
        abandoned: false,
        status: 0,
        headers: null,
        bytes: 0,
        chunks: [],
        answered: false,
        slot: null,
        encoding: chooseEncoding(req.headers?.["accept-encoding"]),
        compressing: null,
      };
      job.key = cacheKey(job);
      if (job.key && replyFromCache(job.key, res)) return;
      if (queue.length >= queueLimit)
        return refuse(res, 503, "The service is busy. Try again shortly.", {
          "Retry-After": "5",
        });
      // The page cancels requests it no longer needs, such as an old map view.
      res.on("close", () => {
        if (res.writableFinished) return;
        job.abandoned = true;
        const waiting = queue.indexOf(job);
        if (waiting >= 0) queue.splice(waiting, 1);
        else if (job.slot?.job === job)
          job.grace = setTimeout(() => {
            if (job.slot.job === job) stopWorker(job.slot);
          }, abandonGraceMs);
      });
      queue.push(job);
      pump();
    },
    stats() {
      return {
        workers: slots.filter((slot) => !slot.stopping).length,
        busy: slots.filter((slot) => slot.job).length,
        queued: queue.length,
      };
    },
    close() {
      closing = true;
      return Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
}
