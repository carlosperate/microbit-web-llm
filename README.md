# micro:bit Web LLM

A web based AI coding chat app for the BBC micro:bit.

It pairs a Small Language Model (SML) chat with a live [MakeCode](https://makecode.microbit.org/) editor instance.
This is intended for experimentation with small models capable to run completely in the browser via WebGPU, without any server backend or API calls.

## What's here

To build this project we've created two main components:

- **[makecode-mcp](packages/makecode-mcp/)**: A TypeScript package that provides a Model Context Protocol (MCP) server to interact with the MakeCode editor. It ships two targets:
  - A React `MakeCodePanel` that can be embedded in any React app and that drives an embedded MakeCode editor via [@microbit/makecode-embed](https://github.com/microbit-foundation/makecode-embed) library.
  - An [MCP](https://modelcontextprotocol.io) server using Puppeteer to drive a MakeCode editor to expose the same tools to any MCP client (Claude Desktop, LM Studio, Copilot, etc.).
- **[app](packages/app/)**: A React web application. Split-pane UI with a [WebLLM](https://webllm.mlc.ai/) chat on the left and a live MakeCode editor on the right. Everything runs in the browser, no backend, no API proxy.

See [packages/makecode-mcp/README.md](packages/makecode-mcp/README.md) for MCP client setup details and documentation.

## Quick start

Requirements: Node.js 20+, npm 10+, and a WebGPU-capable browser (Chrome 113+) to run the app.

```bash
npm install                         # install all workspace dependencies
npm run build --workspaces          # build all packages
npm run dev -w app                  # launch the web app on http://localhost:5173
```

First model load in the app downloads several GB (depending on the picker selection) and is cached by the browser.

## Common scripts

```bash
npm run build --workspaces          # build every package
npm run test --workspaces           # unit tests (Vitest)
npm run test:e2e                    # Playwright end-to-end tests
npm run dev -w app                  # run the web app
npm run dev:test-mcp -w makecode-mcp # build + launch MCP Inspector against the stdio server
```

Package manager is **npm workspaces** — do not use pnpm or yarn. TypeScript project references are used across packages, so run `npm run build --workspaces` after changes in `makecode-mcp` before running `app`.

## How the pieces fit

```
┌────────────────────────────────┐        ┌───────────────────────────┐
│ app (WebLLM chat + MakeCode)   │        │ Any MCP client            │
│                                │        │ (Claude Desktop, etc.)    │
│  ChatPanel ── IframeExecutor ──┼──┐     └──────────┬────────────────┘
│                       ▲        │  │                │ stdio
│                       │        │  │                ▼
│                 MakeCodePanel  │  │     ┌───────────────────────────┐
└────────────────────────────────┘  │     │ makecode-mcp (server)     │
                                    │     │  TabExecutor → Puppeteer  │
              same shared tool ─────┘     │  tabs → MakeCode iframe   │
              schemas & executor          └───────────────────────────┘
              contract
```

The tool schemas in [`packages/makecode-mcp/src/shared/tools.ts`](packages/makecode-mcp/src/shared/tools.ts) are the single source of truth. Both targets expose the same core operations; only the server exposes session lifecycle tools and `get_hex_file_from_code`.

## Using the MCP server with external clients

The `makecode-mcp` package can be wired into Claude Desktop, GitHub Copilot (VS Code), and LM Studio as a stdio MCP server. See the [package README](packages/makecode-mcp/README.md#configuring-mcp-clients) for per-client configuration snippets.

## License

This project is a research/teaching POC. See individual package manifests for dependencies' licenses.
