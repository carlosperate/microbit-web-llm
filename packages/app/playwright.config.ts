import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
