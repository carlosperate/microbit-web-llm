# MakeCode MCP — Implementation Plan

## Overview

A monorepo containing two packages:

- **`makecode-mcp`** — a TypeScript library that owns all MakeCode integration logic. It can operate as an in-browser React component or as a standalone Node.js MCP server.
- **`app`** — a React + Vite web application with a split-pane UI: LLM chat on the right (WebLLM, fully in-browser) and the MakeCode editor on the right.

***

## Monorepo Structure

```
/
├── packages/
│   ├── makecode-mcp/
│   │   ├── src/
│   │   │   ├── shared/        ← Tool JSON schemas (used by both targets)
│   │   │   ├── browser/       ← IframeExecutor + React component
│   │   │   └── server/        ← PuppeteerExecutor + MCP server
│   │   └── package.json       ← Two entry points: /browser and /server
│   └── app/
│       ├── src/
│       │   ├── chat/          ← WebLLM chat panel
│       │   └── App.tsx        ← Split-pane layout
│       └── package.json
├── pnpm-workspace.yaml
└── package.json
```

***

## Package: `makecode-mcp`

### Shared (`src/shared/`)

Defines the tool schemas as plain JSON-serialisable objects in OpenAI function-calling format. No runtime dependencies. Both the browser and server import from here.

**Tools:**

| Tool | Arguments | Returns | Available in |
|------|-----------|---------|--------------|
| `get_current_code` | none | TypeScript string | Browser only |
| `set_code` | `code: string` | void | Browser only |
| `get_blocks_svg` | none | SVG string | Browser only |
| `get_hex_file` | none | base64 string | Browser only |
| `get_blocks_svg_from_code` | `code: string` | SVG string | Both |
| `get_hex_file_from_code` | `code: string` | base64 string | Both |

The browser registers all six tools. The MCP server registers only `get_blocks_svg_from_code` and `get_hex_file_from_code`.

Tool descriptions include explicit guidance for the LLM — for example, `get_blocks_svg` states that code must have been loaded via `set_code` first, and returns a descriptive error if the editor is empty.

### Browser (`src/browser/`)

**`IframeExecutor`** — implements all six tools against a live MakeCode iframe using `postMessage`. Wraps the raw message protocol from `makecode-embed` in a Promise-based API. Maintains a reference to the iframe DOM element.

**`MakeCodePanel`** — a React component that internally uses the `makecode-embed` library to render the MakeCode iframe, and exposes an `IframeExecutor` instance via a ref or context. The host app mounts this component and gets back an executor it can pass to the chat panel.

Key things to verify against `makecode-embed` docs before implementing:
- Exact `postMessage` message types for reading and writing code
- How to capture the blocks SVG from the iframe DOM or via a message
- How to trigger hex compilation and intercept the result

### Server (`src/server/`)

**`BrowserPool`** — manages one persistent Puppeteer browser process. Exposes a `withTab(fn)` method that opens a fresh MakeCode tab, runs the callback, then closes the tab. The browser stays alive between calls.

**`TabExecutor`** — implements `get_blocks_svg_from_code` and `get_hex_file_from_code` using Puppeteer. Each call injects the TypeScript code into a fresh tab, waits for MakeCode to render, then captures the result.

Key things to verify with a Puppeteer spike before committing to implementation:
- Whether blocks SVG is accessible in the DOM (e.g. `page.$eval('.blocks-svg', ...)`) or requires a `postMessage` round-trip
- Whether hex compilation can be triggered programmatically and the binary intercepted (likely via download interception or a MakeCode API call)

**`McpServer`** — sets up an MCP server using `@modelcontextprotocol/sdk` with SSE or stdio transport. Registers the two `_from_code` tools and delegates execution to `TabExecutor`.

***

## Package: `app`

A standard React + Vite application. Imports `MakeCodePanel` and `IframeExecutor` from `makecode-mcp/browser`. Imports WebLLM from `@mlc-ai/web-llm`.

### Layout

Split-pane: chat panel on the left (~35% width), MakeCode editor on the right (~65% width). No persistence between sessions.

### Chat Panel

- Powered by WebLLM running fully in-browser on WebGPU (recommended model: Qwen2.5-Coder 7B Instruct, ~4–5GB cached after first load)
- OpenAI-compatible function-calling API — the tool schemas from `makecode-mcp/shared` are passed directly as the `tools` array
- Agentic tool-call loop: the LLM may call multiple tools before producing a final text response
- System prompt injects context: the LLM is a micro:bit coding assistant, the editor maintains state across the conversation, `set_code` followed by `get_blocks_svg` is a valid multi-turn pattern
- Streaming token output

### Tool Execution in the App

The `MakeCodePanel` component exposes an `IframeExecutor`. The chat panel receives this executor and uses it to dispatch tool calls from the LLM. The only shared dependency between the two panels is this executor instance — no global state or event bus.

```
ChatPanel (WebLLM) ──tool call──► IframeExecutor ──postMessage──► MakeCode iframe
                   ◄──result─────                 ◄──message──────
```

***

## Implementation Phases

### Phase 1 — Spike (before writing production code)

Verify the two highest-risk unknowns:

1. **Blocks SVG extraction** — open MakeCode in a Puppeteer tab, inject some TypeScript, and confirm the SVG is accessible in the DOM or via `postMessage`.
2. **Hex file interception** — trigger compilation in Puppeteer and confirm the binary can be intercepted without a real browser download.

These two experiments determine whether the server-side tools are viable. If either fails, the fallback is generating a MakeCode share URL instead.

### Phase 2 — `makecode-mcp` browser target

1. Set up the monorepo (pnpm workspaces, TypeScript project references)
2. Implement `shared/tools.ts` — all six tool schemas
3. Implement `IframeExecutor` — Promise-based `postMessage` wrapper
4. Implement `MakeCodePanel` React component
5. Write integration tests against a real MakeCode iframe

### Phase 3 — `app`

1. Scaffold React + Vite app
2. Build split-pane layout
3. Integrate `MakeCodePanel`
4. Integrate WebLLM with tool-call loop
5. Wire executor to chat panel
6. End-to-end test: user asks a question → LLM calls `set_code` → editor updates → LLM calls `get_blocks_svg` → SVG displayed in chat

### Phase 4 — `makecode-mcp` server target

1. Implement `BrowserPool` and `TabExecutor`
2. Implement `McpServer`
3. Test with Claude Desktop or MCP Inspector
4. End-to-end test: Claude generates code → `get_blocks_svg_from_code` returns SVG → displayed in Claude chat

***

## Open Questions

- **MakeCode `postMessage` API** — the exact message types for `get_current_code`, `set_code`, and `get_blocks_svg` need to be confirmed against the `makecode-embed` source or docs before Phase 2 begins.
- **Hex interception** — needs the Phase 1 spike to confirm feasibility.
- **WebLLM model choice** — Qwen2.5-Coder 7B is recommended but the first-load size (~4–5GB) may be a concern. Phi-3.5 Mini (~2GB) is a fallback with weaker code quality.
- **MCP transport** — SSE (for remote clients like Claude.ai) vs stdio (for local clients like Claude Desktop). May need to support both.