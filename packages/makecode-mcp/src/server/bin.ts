#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import puppeteer from "puppeteer";
import { BrowserPool } from "./browser-pool.js";
import { parseHeadedFlag } from "./cli-options.js";
import { adaptPuppeteerBrowser } from "./puppeteer-browser-adapter.js";
import { PuppeteerTabPool } from "./puppeteer-tab-pool.js";
import { TabExecutor } from "./tab-executor.js";
import { buildMcpServer } from "./mcp-server.js";

async function main() {
  const headed = parseHeadedFlag(process.argv, process.env);
  const launch = (headless: boolean) => async () =>
    adaptPuppeteerBrowser(
      await puppeteer.launch({
        headless,
        defaultViewport: null,
        protocolTimeout: 300_000,
      }),
    );
  const renderPool = new BrowserPool(launch(true));
  const sessionPool = new BrowserPool(launch(!headed));
  const pool = new PuppeteerTabPool({ renderPool, sessionPool, headed });
  const executor = new TabExecutor(pool);

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
