// Fetches country extracts one at a time. A file only takes its final name after
// its published checksum is confirmed, so a failed or stopped download never
// replaces a good extract. Paused downloads keep their partial file and continue
// with an HTTP range request.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const USER_AGENT = "wayfinder-local-app";
const PART_SUFFIX = ".download.part";
const STALE_PART_MS = 24 * 60 * 60 * 1000;
const STALL_MS = 60_000;
const LOG_LIMIT = 200;
const LOG_EVERY_PERCENT = 10;
const IN_PROGRESS = new Set(["queued", "downloading", "verifying", "paused"]);

class ChecksumError extends Error {}

const megabytes = (bytes) => (bytes / 1e6).toFixed(1) + " MB";
const fileSize = async (file) => (await stat(file).catch(() => null))?.size ?? 0;

async function addFileToHash(hash, file) {
  for await (const chunk of createReadStream(file)) hash.update(chunk);
}

function rangeStart(response) {
  const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

function rangeTotal(response) {
  const match = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

// The running history shown in the page's console, shared by downloads and builds.
export function createActivityLog({ now = Date.now } = {}) {
  const entries = [];
  let sequence = 0;
  return {
    add(name, text, level = "info") {
      entries.push({ id: ++sequence, atMs: now(), name, text, level });
      if (entries.length > LOG_LIMIT) entries.shift();
    },
    entries: () => entries,
  };
}

export function createDownloadManager({
  directory,
  fetchImpl = fetch,
  stallMs = STALL_MS,
  now = Date.now,
  activity = createActivityLog({ now }),
}) {
  const jobs = new Map();
  const queue = [];
  let active = null;
  let running = Promise.resolve();

  const log = (job, text, level) => activity.add(job.name, text, level);

  async function removeAbandonedParts() {
    const names = await readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(PART_SUFFIX)) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      // A recent part may belong to another server running in this folder.
      if (info && Date.now() - info.mtimeMs > STALE_PART_MS)
        await unlink(file).catch(() => {});
    }
  }
  removeAbandonedParts();

  async function publishedChecksum(job, signal) {
    const response = await fetchImpl(job.url + ".md5", {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!response.ok)
      throw new Error("The website's checksum is unavailable.");
    const checksum = (await response.text()).split(/\s/)[0];
    if (!/^[a-f0-9]{32}$/.test(checksum))
      throw new Error("The website published an invalid checksum.");
    return checksum;
  }

  async function isAlreadyCurrent(job, target) {
    const info = await stat(target).catch(() => null);
    if (!info || (job.totalBytes && info.size !== job.totalBytes)) return false;
    const hash = createHash("md5");
    await addFileToHash(hash, target);
    return hash.digest("hex") === job.checksum;
  }

  function noteProgress(job) {
    const moment = now();
    if (moment - job.rateAt >= 1000) {
      job.bytesPerSecond = Math.round(
        ((job.receivedBytes - job.rateBytes) * 1000) / (moment - job.rateAt),
      );
      job.rateAt = moment;
      job.rateBytes = job.receivedBytes;
    }
    if (!job.totalBytes) return;
    const percent = Math.floor((job.receivedBytes / job.totalBytes) * 100);
    const step = percent - (percent % LOG_EVERY_PERCENT);
    if (step > job.loggedPercent && step < 100) {
      job.loggedPercent = step;
      log(job, step + "% (" + megabytes(job.receivedBytes) + ")");
    }
  }

  // Asks the website for the file, continuing from `offset` when it can.
  async function requestFile(job, offset, signal) {
    const response = await fetchImpl(job.resolvedUrl ?? job.url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        ...(offset ? { Range: "bytes=" + offset + "-" } : {}),
      },
      signal,
    });
    if (response.status === 416 && offset) {
      log(job, "The website couldn't continue, starting over.", "warning");
      await response.body?.cancel();
      return requestFile(job, 0, signal);
    }
    if (!response.ok || !response.body)
      throw new Error("The website refused the download.");
    return response;
  }

  async function saveTo(job, controller) {
    const stalled = () => {
      job.stalled = true;
      controller.abort();
    };
    let timer = setTimeout(stalled, stallMs);
    try {
      const offset = await fileSize(job.part);
      const response = await requestFile(job, offset, controller.signal);
      // The latest-file URL redirects to a dated file. Staying on that file
      // means a daily rebuild can't change the bytes halfway through.
      if (response.url && new URL(response.url).hostname.endsWith("geofabrik.de"))
        job.resolvedUrl = response.url;

      const continuing = response.status === 206 && rangeStart(response) === offset;
      const hash = createHash("md5");
      if (continuing) {
        await addFileToHash(hash, job.part);
        job.totalBytes = rangeTotal(response) ?? job.totalBytes;
      } else {
        if (offset)
          log(job, "The website couldn't continue, starting over.", "warning");
        const announced = Number(response.headers.get("content-length"));
        if (announced > 0) job.totalBytes = announced;
      }
      job.receivedBytes = continuing ? offset : 0;
      job.rateAt = now();
      job.rateBytes = job.receivedBytes;
      job.loggedPercent = job.totalBytes
        ? Math.floor((job.receivedBytes / job.totalBytes) * 10) * 10
        : 0;

      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source) {
          for await (const chunk of source) {
            clearTimeout(timer);
            timer = setTimeout(stalled, stallMs);
            hash.update(chunk);
            job.receivedBytes += chunk.length;
            noteProgress(job);
            yield chunk;
          }
        },
        createWriteStream(job.part, { flags: continuing ? "a" : "w" }),
        { signal: controller.signal },
      );
      job.state = "verifying";
      log(job, "Download finished, checking the file");
      if (hash.digest("hex") !== job.checksum)
        throw new ChecksumError(
          "The file failed its checksum. Try downloading again.",
        );
    } finally {
      clearTimeout(timer);
    }
  }

  function describeFailure(job, error) {
    if (job.stalled) return "The download stalled. Try again to continue.";
    if (error.code === "ENOSPC") return "The disk is full.";
    if (error.message === "fetch failed") return "Couldn't reach the website.";
    return error.message;
  }

  async function removePart(job) {
    if (job.part) await unlink(job.part).catch(() => {});
    job.part = null;
  }

  async function run(job) {
    const target = path.join(directory, job.slug + ".osm.pbf");
    const controller = new AbortController();
    const resuming = Boolean(job.part);
    job.controller = controller;
    job.state = "downloading";
    job.stalled = false;
    job.error = null;
    job.bytesPerSecond = 0;
    job.part ??= target + "." + randomUUID() + PART_SUFFIX;
    try {
      await mkdir(directory, { recursive: true });
      job.checksum ??= await publishedChecksum(job, controller.signal);
      if (!resuming && (await isAlreadyCurrent(job, target))) {
        const moment = new Date();
        await utimes(target, moment, moment);
        job.receivedBytes = job.totalBytes ?? 0;
        log(job, "Already up to date, nothing to download", "success");
        job.state = "done";
        await removePart(job);
        return;
      }
      log(
        job,
        resuming
          ? "Resuming from " + megabytes(await fileSize(job.part))
          : "Started" + (job.totalBytes ? " (" + megabytes(job.totalBytes) + ")" : ""),
      );
      await saveTo(job, controller);
      await rename(job.part, target);
      job.part = null;
      job.state = "done";
      log(
        job,
        "Verified and saved as input/osm/" + path.basename(target),
        "success",
      );
    } catch (error) {
      if (job.stopRequested) {
        job.state = "cancelled";
        await removePart(job);
        log(job, "Stopped, partial file removed", "warning");
      } else if (job.pauseRequested) {
        job.state = "paused";
        job.receivedBytes = await fileSize(job.part);
        log(job, "Paused at " + megabytes(job.receivedBytes), "warning");
      } else {
        job.state = "failed";
        job.error = describeFailure(job, error);
        if (error instanceof ChecksumError) await removePart(job);
        else job.receivedBytes = await fileSize(job.part);
        log(job, "Failed: " + job.error, "error");
        console.error("Download failed for " + job.slug + ":", error.message);
      }
    } finally {
      job.controller = null;
      job.pauseRequested = false;
      job.stopRequested = false;
      job.bytesPerSecond = 0;
    }
  }

  function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = job;
    running = run(job).finally(() => {
      active = null;
      pump();
    });
  }

  function enqueue(job) {
    job.state = "queued";
    queue.push(job);
    if (active) log(job, "Waiting for the current download to finish");
    pump();
  }

  function view(job) {
    const { code, name, state, receivedBytes, totalBytes, error } = job;
    const { bytesPerSecond } = job;
    return {
      code,
      name,
      state,
      receivedBytes,
      totalBytes,
      error,
      bytesPerSecond,
    };
  }

  return {
    start({ code, name, slug, url, totalBytes }) {
      const existing = jobs.get(slug);
      if (existing && ["queued", "downloading", "verifying"].includes(existing.state))
        return existing;
      // A paused or interrupted download continues from its partial file.
      if (existing?.part) {
        existing.code = code;
        enqueue(existing);
        return existing;
      }
      const job = {
        code,
        name,
        slug,
        url,
        totalBytes: totalBytes ?? null,
        receivedBytes: 0,
        bytesPerSecond: 0,
        error: null,
      };
      jobs.set(slug, job);
      enqueue(job);
      return job;
    },
    pause(slug) {
      const job = jobs.get(slug);
      if (job?.state !== "downloading") return false;
      job.pauseRequested = true;
      job.controller?.abort();
      return true;
    },
    async stop(slug) {
      const job = jobs.get(slug);
      if (!job || !IN_PROGRESS.has(job.state)) {
        if (job?.part) await removePart(job);
        return false;
      }
      if (job.state === "queued" || job.state === "paused") {
        const waiting = queue.indexOf(job);
        if (waiting >= 0) queue.splice(waiting, 1);
        job.state = "cancelled";
        await removePart(job);
        log(job, "Stopped", "warning");
        return true;
      }
      job.stopRequested = true;
      job.controller?.abort();
      return true;
    },
    view(slug) {
      const job = jobs.get(slug);
      return job ? view(job) : null;
    },
    jobs: () =>
      [...jobs.values()].filter((job) => IN_PROGRESS.has(job.state)).map(view),
    log: () => activity.entries(),
    isDownloading(slug) {
      const state = jobs.get(slug)?.state;
      return ["queued", "downloading", "verifying"].includes(state);
    },
    isBusy: () => Boolean(active) || queue.length > 0,
    whenIdle: async () => {
      while (active || queue.length) await running;
    },
  };
}
