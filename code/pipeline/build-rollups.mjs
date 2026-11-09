// Stores the Freshness answer for each selection common enough to be slow.
// Runs near the end of a database build, using the server's own query so the
// stored answers are exactly what a live request would return.
import { availableParallelism } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import {
  buildScope,
  computeFreshness,
  freshnessRollupName,
  openForBuild,
} from "../server/analytics.mjs";

const minimumObjects = Number(process.env.WAYFINDER_ROLLUP_MIN || 50_000);
const kinds = { all: "nodes + ways + relations", node: "nodes", way: "ways", relation: "relations" };

function findJobs(db, dataset) {
  const jobs = [];
  dataset.areas.forEach((area, areaIndex) => {
    for (const [kind, count] of Object.entries(kinds)) {
      const objects = Object.entries(area.objects)
        .filter(([name]) => kind === "all" || name === kind)
        .reduce((sum, [, amount]) => sum + amount, 0);
      if (objects >= minimumObjects)
        jobs.push({ areaIndex, kind, key: null, value: null });
      for (const { key } of db
        .prepare(`SELECT key FROM tag_keys WHERE region=? AND ${count} >= ?`)
        .all(area.id, minimumObjects))
        jobs.push({ areaIndex, kind, key, value: null });
      for (const { key, value } of db
        .prepare(`SELECT key, value FROM tag_values WHERE region=? AND ${count} >= ?`)
        .all(area.id, minimumObjects))
        jobs.push({ areaIndex, kind, key, value });
    }
  });
  return jobs;
}

if (isMainThread) {
  const file = process.argv[2];
  const { db, dataset } = openForBuild(file);
  const jobs = findJobs(db, dataset);
  db.close();
  const workers = Math.max(1, Math.min(8, availableParallelism() - 2, jobs.length));
  const results = [];
  let next = 0;
  let failure = null;
  await Promise.all(
    Array.from({ length: jobs.length ? workers : 0 }, () =>
      new Promise((resolve) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { file } });
        const send = () => {
          if (next < jobs.length && !failure) worker.postMessage(jobs[next++]);
          else worker.terminate().then(resolve);
        };
        worker.on("message", (message) => {
          if (message) results.push(message);
          send();
        });
        worker.on("error", (error) => {
          failure = error;
          resolve();
        });
      }),
    ),
  );
  if (failure) throw failure;
  // Written only now, because readers and a writer can't share a journal-less file.
  const output = new DatabaseSync(file);
  output.exec(`
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    CREATE TABLE freshness_rollups (name TEXT PRIMARY KEY, payload BLOB NOT NULL) WITHOUT ROWID;
    BEGIN;
  `);
  const insert = output.prepare("INSERT INTO freshness_rollups VALUES (?, ?)");
  for (const { name, payload } of results) insert.run(name, payload);
  output.exec("COMMIT");
  output.close();
  console.log(`Stored Freshness for ${results.length} selections`);
} else {
  const { db, dataset } = openForBuild(workerData.file);
  parentPort.on("message", ({ areaIndex, kind, key, value }) => {
    const scope = buildScope(db, areaIndex, kind, key, value);
    parentPort.postMessage({
      name: freshnessRollupName(areaIndex, kind, key, value),
      payload: deflateSync(JSON.stringify(computeFreshness(db, dataset, scope))),
    });
  });
  parentPort.postMessage(null);
}
