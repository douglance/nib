import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const privateOrigin = "http://localhost:8789";
const publicOrigin = "http://localhost:8790";
const publicWorkerDirectory = resolve(
  process.env.NIB_PUBLIC_WORKER_DIR ?? "../cloudflare",
);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: privateOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "npx wrangler dev --config wrangler.e2e.jsonc --port 8790 --local --persist-to .wrangler/e2e",
      cwd: publicWorkerDirectory,
      url: `${publicOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run e2e:serve",
      cwd: resolve("."),
      url: `${privateOrigin}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      testIgnore: "**/passkey.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: "**/passkey.spec.ts",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "mobile-chromium",
      testIgnore: "**/passkey.spec.ts",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
