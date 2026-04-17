import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  // Retries on CI; none locally so failures are visible immediately.
  retries: process.env.CI ? 2 : 0,
  // MakeCode loads from the network — keep workers sequential to avoid
  // hammering the CDN and to make console output readable.
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx vite --config ${resolve(__dirname, "test-page/vite.config.ts")}`,
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
