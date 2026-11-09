// Walks through every feature in a real browser on real Luxembourg data, and
// saves a screenshot of each to docs/screenshots. Exits with an error if a
// feature can't be used or the browser reports an error.
//
//   npm run screenshots              every feature
//   npm run screenshots -- map,table only those named
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { analyticsDir, repoRoot, webDist } from "../../server/paths.mjs";

const only = process.argv[2]?.split(",");
const out = path.join(repoRoot, "docs/screenshots");
const port = Number(process.env.SCREENSHOT_PORT || 5198);
const base = `http://localhost:${port}`;
const CITY = [6.1296, 49.6116];

for (const [file, fix] of [
  [path.join(analyticsDir, "LU.sqlite"), "npm run analytics:setup"],
  [path.join(webDist, "index.html"), "npm run build"],
]) {
  if (!existsSync(file)) {
    console.error(`Missing ${path.relative(repoRoot, file)}. Run: ${fix}`);
    process.exit(1);
  }
}
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const map = (page) => page.locator(".ax-feature-map");

async function settled(page, extra = 500) {
  await page.waitForLoadState("networkidle");
  for (let i = 0; i < 80; i++) {
    const ready = await map(page).evaluate((host) => {
      const m = host.wayfinder.map;
      return m.isStyleLoaded() && m.areTilesLoaded() && !m.isMoving();
    });
    if (ready) break;
    await sleep(150);
  }
  await page.waitForLoadState("networkidle");
  await sleep(extra);
}

async function objects(page) {
  for (let i = 0; i < 80; i++) {
    if (await map(page).evaluate((host) => host.wayfinder.drawn.size > 0)) return;
    await sleep(150);
  }
  throw Error("No objects were drawn on the map.");
}

async function open(page) {
  await page.goto(base + "/");
  await map(page).waitFor();
  const country = page.getByLabel("Country");
  if ((await country.inputValue()) !== "LU") {
    await country.selectOption("LU");
    await page.waitForLoadState("networkidle");
    await sleep(500);
  }
  await objects(page);
  await settled(page);
}

async function allValues(page) {
  await page.getByRole("button", { name: /^Tag value:/ }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForLoadState("networkidle");
  await objects(page);
  await settled(page);
}

async function zoomToCity(page, zoom) {
  await map(page).evaluate(
    (host, [center, level]) => host.wayfinder.map.jumpTo({ center, zoom: level }),
    [CITY, zoom],
  );
  await sleep(700);
  await objects(page);
  await settled(page);
}

async function tableView(page) {
  await open(page);
  await allValues(page);
  await page.getByRole("button", { name: /table view/i }).click();
  await page.locator(".ax-tag-table-content").waitFor();
}

// A feature returns an element to capture, "full" for the whole page, or
// nothing for the visible window.
const features = {
  async map(page) {
    await open(page);
    await allValues(page);
  },
  async filters(page) {
    await open(page);
    await page.getByRole("button", { name: /^Tag key:/ }).click();
    await sleep(700);
  },
  async "multiple-keys"(page) {
    await open(page);
    await page.getByRole("button", { name: /^Tag key:/ }).click();
    await page.getByRole("checkbox", { name: /^amenity/ }).click();
    await sleep(500);
    await page.getByRole("checkbox", { name: /^highway/ }).click();
    await sleep(500);
    await page.getByPlaceholder(/^Search keys/).fill("shop");
    await page.waitForLoadState("networkidle");
    await sleep(600);
    await page.getByRole("checkbox", { name: /^shop/ }).first().click();
    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForLoadState("networkidle");
    await objects(page);
    await settled(page);
  },
  async region(page) {
    await open(page);
    await allValues(page);
    const select = page.getByLabel("Canton");
    const value = await select.evaluate(
      (element) =>
        [...element.options].find((o) => o.textContent.includes("Echternach")).value,
    );
    await select.selectOption(value);
    await page.waitForLoadState("networkidle");
    await sleep(1200);
    await objects(page);
    await settled(page);
  },
  async "object-details"(page) {
    await open(page);
    await allValues(page);
    await zoomToCity(page, 16);
    // The line whose midpoint is nearest the middle of the map.
    const point = await map(page).evaluate((host) => {
      const m = host.wayfinder.map;
      const { width, height } = m.getContainer().getBoundingClientRect();
      let best = null;
      for (const feature of m.getSource("matches").serialize().data.features) {
        if (feature.geometry.type !== "LineString") continue;
        const line = feature.geometry.coordinates;
        const a = line[Math.floor((line.length - 1) / 2)];
        const b = line[Math.floor((line.length - 1) / 2) + 1] ?? a;
        const { x, y } = m.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        const distance = Math.hypot(x - width / 2, y - height / 2);
        if (!best || distance < best.distance) best = { x, y, distance };
      }
      return best;
    });
    await map(page).click({ position: { x: point.x, y: point.y } });
    await page.locator(".ax-object-inspector").waitFor();
    await settled(page);
  },
  async "go-to-location"(page) {
    await open(page);
    await page.getByPlaceholder("Go to location").fill("Esch");
    await page.waitForLoadState("networkidle");
    await sleep(900);
  },
  async nearby(page) {
    await open(page);
    await allValues(page);
    await zoomToCity(page, 16);
    const box = await map(page).boundingBox();
    await map(page).click({
      button: "right",
      position: { x: box.width / 2, y: box.height / 2 },
    });
    await page.getByRole("button", { name: /query nearby/i }).click();
    await page.waitForLoadState("networkidle");
    await sleep(1000);
    await settled(page);
  },
  async table(page) {
    await tableView(page);
    await page.waitForLoadState("networkidle");
    await sleep(800);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: /export csv/i })
      .or(page.getByRole("link", { name: /export csv/i }))
      .click();
    const file = await download;
    if (!file.suggestedFilename().endsWith(".csv"))
      throw Error("Export CSV did not produce a CSV file.");
    await sleep(300);
  },
  async "by-region"(page) {
    // Tall enough that the whole comparison table is on the page.
    await page.setViewportSize({ width: 1280, height: 1500 });
    await tableView(page);
    const section = page.locator(".ax-tag-regions");
    await section.locator("tbody tr").first().waitFor();
    await page.waitForLoadState("networkidle");
    await sleep(600);
    return section;
  },
  async freshness(page) {
    await open(page);
    await allValues(page);
    await page.getByRole("button", { name: /freshness/i }).click();
    await page.locator(".ax-freshness-stats").waitFor();
    await page.waitForLoadState("networkidle");
    await sleep(2500);
    return "full";
  },
  async satellite(page) {
    await open(page);
    await allValues(page);
    await zoomToCity(page, 15);
    await page.getByRole("button", { name: "Satellite" }).click();
    await page.waitForLoadState("networkidle");
    await sleep(3000);
    await settled(page, 1200);
  },
  async countries(page) {
    await page.goto(base + "/countries");
    await page.locator('[aria-label="Search all countries"]').waitFor();
    await page.waitForLoadState("networkidle");
    // Sizes and estimates appear once the download site has been checked.
    for (let i = 0; i < 180; i++) {
      if (!(await page.getByText(/Checking website/).count())) break;
      await sleep(1000);
    }
    await page.getByText("Europe", { exact: true }).first().click();
    await sleep(800);
    await page.getByText("Austria", { exact: true }).first().click();
    await page.waitForLoadState("networkidle");
    await sleep(1000);
  },
};

const unknown = only?.filter((name) => !features[name]);
if (unknown?.length) {
  console.error("Unknown feature: " + unknown.join(", "));
  process.exit(1);
}

const server = spawn(process.execPath, ["--no-warnings", "code/server/index.mjs"], {
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  stdio: "ignore",
});
let failed = 0;
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(base + "/api/config").then((r) => r.ok, () => false)) break;
    await sleep(500);
  }
  const browser = await chromium.launch({ channel: "chrome" });
  for (const [name, visit] of Object.entries(features)) {
    if (only && !only.includes(name)) continue;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1.5,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    try {
      const target = await visit(page);
      // Aerial photos are far smaller as JPEG.
      const options =
        name === "satellite"
          ? { path: path.join(out, name + ".jpg"), type: "jpeg", quality: 80 }
          : { path: path.join(out, name + ".png") };
      if (target && target !== "full") await target.screenshot(options);
      else await page.screenshot({ ...options, fullPage: target === "full" });
      if (problems.length) throw Error("Browser error: " + problems[0]);
      console.log("pass  " + name);
    } catch (error) {
      failed++;
      console.log("FAIL  " + name + "  " + error.message.split("\n")[0]);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGKILL");
}
console.log(failed ? `${failed} feature(s) failed.` : "Every feature passed.");
process.exit(failed ? 1 : 0);
