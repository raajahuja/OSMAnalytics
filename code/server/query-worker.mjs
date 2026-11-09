// Runs one analytics request at a time away from the server's main thread.
import { once } from "node:events";
import { Writable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import { serveAnalytics } from "./analytics.mjs";

const CHUNK_BYTES = 64 * 1024;

// Stands in for the HTTP response and passes everything back to the main thread.
class WorkerResponse extends Writable {
  constructor(id) {
    super();
    this.id = id;
    this.headersSent = false;
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  writeHead(status, headers) {
    this.headersSent = true;
    parentPort.postMessage({ id: this.id, type: "head", status, headers });
  }

  flushBuffer() {
    if (!this.bufferedBytes) return;
    const data = Buffer.concat(this.buffered, this.bufferedBytes);
    this.buffered = [];
    this.bufferedBytes = 0;
    parentPort.postMessage({ id: this.id, type: "chunk", data });
  }

  _write(chunk, _encoding, done) {
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    if (this.bufferedBytes >= CHUNK_BYTES) this.flushBuffer();
    done();
  }

  _final(done) {
    this.flushBuffer();
    done();
  }
}

function workerRequest(method, body) {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

parentPort.on("message", async ({ id, method, path, body }) => {
  const res = new WorkerResponse(id);
  try {
    await serveAnalytics(
      workerRequest(method, body),
      res,
      new URL(path, "http://localhost"),
      workerData,
    );
    if (!res.writableFinished) await once(res, "finish");
    parentPort.postMessage({ id, type: "end" });
  } catch (error) {
    console.error(error);
    parentPort.postMessage({
      id,
      type: "error",
      headersSent: res.headersSent,
    });
  }
});
