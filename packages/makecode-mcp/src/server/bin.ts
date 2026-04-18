#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import puppeteer from "puppeteer";
import { PuppeteerTabPool } from "./puppeteer-tab-pool.js";
import { TabExecutor } from "./tab-executor.js";
import { buildMcpServer } from "./mcp-server.js";

async function main() {
  const pool = new PuppeteerTabPool(() =>
    puppeteer.launch({
      headless: true,
      defaultViewport: null,
      protocolTimeout: 300_000,
    }),
  );
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
