#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Launcher } from "chrome-launcher";
import puppeteer from "puppeteer";
import { BrowserPool } from "./browser-pool.js";
import { resolveChromePath } from "./chrome-path.js";
import { parseHeadedFlag } from "./cli-options.js";
import { adaptPuppeteerBrowser } from "./puppeteer-browser-adapter.js";
import { PuppeteerTabPool } from "./puppeteer-tab-pool.js";
import { SessionExecutor } from "./session-executor.js";
import { buildMcpServer } from "./mcp-server.js";

async function main() {
  const headed = parseHeadedFlag(process.argv, process.env);
  const executablePath = resolveChromePath({
    env: process.env,
    findSystemChrome: () => Launcher.getFirstInstallation(),
  });
  const launch = async () =>
    adaptPuppeteerBrowser(
      await puppeteer.launch({
        headless: !headed,
        executablePath,
        defaultViewport: null,
        protocolTimeout: 300_000,
        // Keep idle tabs alive. The server holds pages open for its whole
        // lifetime, but Chrome throttles/discards background tabs ("Memory
        // Saver"), which detaches the frame so the next page.evaluate throws
        // "Attempted to use detached Frame". These flags stop that auto-discard;
        // the tab-pool / executor recovery handles whatever still slips through
        // (renderer crash, user closing a headed window).
        args: [
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=CalculateNativeWinOcclusion",
        ],
      }),
    );
  const browserPool = new BrowserPool(launch);
  const pool = new PuppeteerTabPool({ browserPool, headed });
  // Defaults: 30 min idle timeout, reaped on a 1 min interval. An LLM client
  // that crashes between session_start and session_end would otherwise pin its
  // project in memory for the server's whole lifetime.
  const executor = new SessionExecutor(pool);
  // Start the shared editor tab loading immediately. MakeCode can take many
  // seconds on cold cache / slow networks, so prewarming gives the maximum
  // window before the first tool call needs it.
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
