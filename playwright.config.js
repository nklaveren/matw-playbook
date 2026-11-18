import { defineConfig, devices } from "@playwright/test";

// The site is served under the same base path it has in production.
const BASE_URL = process.env.SITE_BASE_URL || "http://127.0.0.1:4173/matw_pb/";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Escape hatch for a machine where the bundled browser cannot run.
        launchOptions: {
          args: ['--enable-unsafe-swiftshader'],
          ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {})
        }
      }
    }
  ],
  webServer: {
    command: "node scripts/serve.mjs",
    url: BASE_URL + "index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
