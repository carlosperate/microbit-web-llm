# micro:bit Web LLM

A web based AI coding chat app for the BBC micro:bit.

It pairs a Small Language Model (SLM) chat with a live [MakeCode](https://makecode.microbit.org/) editor instance.
The goal is to experiment with small models that run entirely in the browser via WebGPU, with no server backend or API calls.

## What's here

The project has two components:

- **[makecode-mcp](packages/makecode-mcp/)**: A TypeScript package that exposes the MakeCode editor to LLMs. It ships two targets:
  - A React `MakeCodePanel` you can embed in any React app, driving the MakeCode editor through [@microbit/makecode-embed](https://github.com/microbit-foundation/makecode-embed).
  - A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that uses Puppeteer to drive the same editor for any MCP client (Claude Desktop, LM Studio, Copilot, etc.).
- **[app](packages/app/)**: A React web app. Split-pane UI with a [WebLLM](https://webllm.mlc.ai/) chat on the left and a live MakeCode editor on the right. Everything runs in the browser; no backend, no API proxy.

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
npm run build --workspaces           # Build every package
npm run test --workspaces            # Unit tests
npm run test:e2e                     # Playwright end-to-end tests
npm run dev -w app                   # Run the web app
npm run dev:test-mcp -w makecode-mcp # Build + launch MCP Inspector against the stdio server
```

## How the pieces fit

```
┌────────────────────────┐      ┌────────────────────────────┐
│ Static web app │       │      │ Any MCP client │           │
│ ---------------┘       │      │ ---------------┘           │
│  ChatThread + WebLLM   │      │ e.g. Claude Desktop,       │
│  engine + tool loop    │      │ LM Studio, Copilot, etc    │
└───────────┬────────────┘      └──────────────┬─────────────┘
            │ imports                          │ stdio
┌───────────▼──────────────────────────────────▼─────────────┐
│ makecode-mcp │                                             │
│ -------------┘               │                             │
│ browser: IframeExecutor      │ MCP server: TabExecutor     │
│          + MakeCodePanel     │         + Puppeteer tab     │
│          ─► MakeCode iframe  │         ─► MakeCode iframe  │
│                                                            │
│  shared: tool schemas, executor interfaces, codecs, logger │
└────────────────────────────────────────────────────────────┘
```

The tool schemas in [`packages/makecode-mcp/src/shared/tools.ts`](packages/makecode-mcp/src/shared/tools.ts) are the single source of truth. The two targets share the editor-state tools (`session_get_code`, `session_set_code`, `session_get_blocks_img`) and the stateless `get_blocks_img_from_code`. The server adds session lifecycle (`session_start`/`session_end`) and the hex-compile tools (`session_get_hex_file`, `get_hex_file_from_code`). The browser target omits hex on purpose: the MakeCode iframe sits next to the chat, so the user downloads (and WebUSB-flashes) directly from MakeCode itself.

## Using the MCP server with external clients

The `makecode-mcp` package can be wired into Claude Desktop, GitHub Copilot (VS Code), and LM Studio as a stdio MCP server. See the [MCP package README](packages/makecode-mcp/README.md#configuring-mcp-clients) for per-client configuration snippets.

## License

Licensed under the [MIT License](LICENSE).
