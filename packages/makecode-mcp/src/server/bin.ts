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
  // Defaults: 30 min idle timeout, reaped on a 1 min interval. Long-lived
  // MCP servers can otherwise accumulate abandoned session tabs indefinitely
  // (an LLM client that crashes between session_start and session_end leaves
  // a tab open forever).
  const executor = new TabExecutor(pool);
  // Start the stateless editor tab loading immediately — MakeCode can take
  // many seconds on cold cache / slow networks, so prewarming gives the
  // maximum window before the first *_from_code call.
  pool.prewarm();

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
