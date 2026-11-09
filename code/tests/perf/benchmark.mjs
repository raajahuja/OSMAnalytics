// Times the API against the real Luxembourg database and checks loose budgets.
// Usage: npm run test:perf [-- --update]   Writes output/reports/perf.json.
import fs from "node:fs";
import path from "node:path";
import { realDatabase, repoRoot, startServer } from "../helpers.mjs";

if (!fs.existsSync(realDatabase)) {
  console.error("Skipped: output/analytics/LU.sqlite is missing.");
  process.exit(0);
}
const country = "/api/analytics/LU";
const all = "5.72,49.44,6.55,50.19";
const city = "6.1248,49.604,6.138,49.615";
const pair = encodeURIComponent(
  JSON.stringify([
    { key: "highway", values: [] },
    { key: "building", values: [] },
  ]),
);
// Budgets are about 3x what a laptop measures, so they catch regressions, not noise.
const scenarios = [
  { name: "dataset summary", url: country, budget: 30 },
  { name: "tag keys, first page", url: country + "/tags", budget: 60 },
  { name: "values of highway", url: country + "/tags?key=highway", budget: 60 },
  {
    name: "values of name, 32k distinct",
    url: country + "/tags?key=name",
    budget: 150,
  },
  {
    name: "search inside name values",
    url: country + "/tags?key=name&q=rue&view=options",
    budget: 150,
  },
  {
    name: "features, highway, whole country",
    url: `${country}/features?key=highway&bbox=${all}`,
    budget: 1500,
  },
  {
    name: "features, building, whole country",
    url: `${country}/features?key=building&bbox=${all}`,
    budget: 1500,
  },
  {
    name: "features, highway, one city",
    url: `${country}/features?key=highway&bbox=${city}`,
    budget: 200,
  },
  {
    name: "selection, highway OR building",
    url: `${country}/selection?filters=${pair}`,
    budget: 900,
  },
  {
    name: "selection, highway AND building",
    url: `${country}/selection?filters=${pair}&match=all`,
    budget: 900,
  },
  {
    name: "nearby, city centre, 250 m",
    url: `${country}/nearby?lat=49.611&lon=6.131&radius=250`,
    budget: 300,
  },
  {
    name: "nearby, city centre, 2 km",
    url: `${country}/nearby?lat=49.611&lon=6.131&radius=2000`,
    budget: 1800,
  },
  {
    name: "features, highway, one canton",
    url: `${country}/features?key=highway&region=09&bbox=${all}`,
    budget: 900,
  },
  {
    name: "selection, two keys, one canton",
    url: `${country}/selection?filters=${pair}&region=09`,
    budget: 900,
  },
  {
    name: "features, every object, whole country",
    url: `${country}/features?filters=%5B%5D&allKeys=1&bbox=${all}`,
    budget: 4000,
  },
  {
    name: "by region, name, every value",
    url: `${country}/tag-regions?key=name`,
    budget: 450,
  },
  {
    name: "freshness, highway",
    url: `${country}/freshness?key=highway`,
    budget: 600,
  },
  {
    name: "freshness, every object",
    url: `${country}/freshness?filters=%5B%5D`,
    budget: 2400,
  },
  {
    name: "object details",
    url: country + "/object/node/4171767660",
    budget: 30,
  },
];
const percentile = (sorted, share) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
const app = await startServer();
const results = [];
try {
  for (const scenario of scenarios) {
    const times = [];
    let bytes = 0;
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      const response = await fetch(app.base + scenario.url);
      bytes = (await response.arrayBuffer()).byteLength;
      if (!response.ok) throw Error(scenario.url + " " + response.status);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    results.push({
      name: scenario.name,
      p50: Math.round(percentile(times, 0.5)),
      max: Math.round(times.at(-1)),
      kilobytes: Math.round(bytes / 1024),
      budget: scenario.budget,
    });
  }
  // Queries run on the single server thread, so a slow one delays everything.
  const slow = fetch(app.base + scenarios[5].url).then((r) => r.arrayBuffer());
  await new Promise((resolve) => setTimeout(resolve, 15));
  const started = performance.now();
  await (await fetch(app.base + "/api/analytics")).arrayBuffer();
  const blocked = Math.round(performance.now() - started);
  await slow;
  results.push({
    name: "trivial request during a slow query",
    p50: blocked,
    max: blocked,
    kilobytes: 0,
    budget: null,
  });
} finally {
  await app.stop();
}
console.table(results);
const reports = path.join(repoRoot, "output/reports");
fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(
  path.join(reports, "perf.json"),
  JSON.stringify(results, null, 2) + "\n",
);
const over = results.filter(({ p50, budget }) => budget && p50 > budget);
if (over.length) {
  console.error("Over budget: " + over.map(({ name }) => name).join(", "));
  process.exit(1);
}
