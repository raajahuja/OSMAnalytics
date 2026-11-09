import { defineConfig } from "@playwright/test";

const port = Number(process.env.VISUAL_PORT || 5199);

export default defineConfig({
  testDir: "code/tests/visual",
  outputDir: "output/reports/visual",
  snapshotPathTemplate:
    "code/tests/visual/baseline/{arg}-{projectName}-{platform}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.005 },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    timezoneId: "UTC",
    locale: "en-GB",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    {
      name: "mobile",
      grepInvert: /@desktop/,
      use: { viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: `node --no-warnings code/tests/visual/serve-fixture.mjs ${port}`,
    url: `http://127.0.0.1:${port}/api/analytics`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
  },
});
