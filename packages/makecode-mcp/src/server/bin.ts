#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Launcher } from "chrome-launcher";
import puppeteer from "puppeteer";
import { BrowserPool } from "./browser-pool.js";
import { resolveChromePath } from "./chrome-path.js";
import { parseHeadedFlag } from "./cli-options.js";
import { adaptPuppeteerBrowser } from "./puppeteer-browser-adapter.js";
import { PuppeteerTabPool } from "./puppeteer-tab-pool.js";
import { TabExecutor } from "./tab-executor.js";
import { buildMcpServer } from "./mcp-server.js";

async function main() {
  const headed = parseHeadedFlag(process.argv, process.env);
  const executablePath = resolveChromePath({
    env: process.env,
    findSystemChrome: () => Launcher.getFirstInstallation(),
  });
  const launch = (headless: boolean) => async () =>
    adaptPuppeteerBrowser(
      await puppeteer.launch({
        headless,
        executablePath,
        defaultViewport: null,
        protocolTimeout: 300_000,
      }),
    );
  const renderPool = new BrowserPool(launch(true));
  const sessionPool = new BrowserPool(launch(!headed));
  const pool = new PuppeteerTabPool({ renderPool, sessionPool, headed });
  const executor = new TabExecutor(pool);
  // Start the render tab loading immediately. The makecode-embed renderer
  // has a 30s `renderready` timeout from `initialize()`; doing this at MCP
  // startup gives slow networks the most time before the first
  // `get_blocks_img_from_code` call.
  pool.prewarmRender();

  const shutdown = async () => {
    await executor.dispose().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = buildMcpServer({ executor });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
