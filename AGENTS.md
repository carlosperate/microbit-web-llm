# AGENTS.md

This file provides context and instructions for AI agents working on this repository.

## Project Summary

This is a monorepo for **MakeCode MCP** — a TypeScript library and companion web app that connects an in-browser LLM chat to a MakeCode micro:bit editor.

The repo has two packages:

- **`packages/makecode-mcp`** — the core library. Owns all MakeCode integration. Has two build targets: `browser` (React + postMessage) and `server` (Node.js + Puppeteer + MCP protocol).
- **`packages/app`** — a React + Vite web app. Split-pane UI: WebLLM chat on the left, MakeCode iframe on the right.

Read `makecode-mcp-plan.md` for the full architecture before making any changes.


## Monorepo Setup

```bash
pnpm install          # install all workspace dependencies
pnpm -r build         # build all packages
pnpm -r test          # run all tests
pnpm --filter app dev # run the app in dev mode
```

Package manager: **pnpm** with workspaces. Do not use npm or yarn.

TypeScript project references are used across packages. Run `pnpm -r build` before running the app if you've changed `makecode-mcp`.


## Key Architectural Rules

### Two executors, one interface

Both browser executor (via iframe) and server executor (via puppeteer tab) implement the same `MakeCodeExecutor` interface from `src/shared/types.ts`. If you add a new tool, implement it in both executors unless the tool table in the plan explicitly marks it as browser-only or server-only.

### Browser-only vs shared tools

This is just an initial set of tools, to be updated or tweaked as needed during development.

| Tool | Browser | Server |
|------|---------|--------|
| `get_current_code` | ✅ | ✅ |
| `set_code` | ✅ | ✅ |
| `get_blocks_svg` | ✅ | ✅ |
| `get_hex_file` | ✅ | ✅ |
| `get_blocks_svg_from_code` | ✅ | ✅ |
| `get_hex_file_from_code` | ✅ | ✅ |


### The `_from_code` variants are pure functions

`get_blocks_svg_from_code` and `get_hex_file_from_code` take TypeScript code as an argument and return an artifact. They must not read or write any persistent editor state. Treat them as stateless — same input always produces the same output.

### `get_blocks_svg` requires loaded code

In browser executor, `getBlocksSvg()` must check that the editor is not empty before proceeding. If it is empty, throw an `Error` with a message written for the LLM to read and self-correct:

```
No code loaded in the editor. Call set_code first to load code before requesting get_blocks_svg.
```

Do not throw a generic error. The message is part of the LLM interaction loop.

### No shared state between chat and editor panels

The only connection between `ChatPanel` and `MakeCodePanel` in the app is the `IframeExecutor` instance passed as a prop. Do not introduce a global store, context, or event bus for this. Keep it a direct dependency.

***

## Phase 1 is a Spike — Do It First

Before implementing any production code in `makecode-mcp`, complete the Phase 1 spike. This is non-negotiable because two unknowns could invalidate the server-side architecture:

### Spike 1 — Blocks SVG extraction

Write a standalone Puppeteer script that:
1. Opens `https://makecode.microbit.org` in a headless tab
2. Waits for the editor to fully load
3. Injects a simple TypeScript snippet (e.g. `basic.showString("hello")`)
4. Attempts to extract the rendered blocks SVG from the DOM

**Pass condition:** an SVG string is returned that visually represents the blocks program.
**Fail condition:** the SVG is not accessible in the DOM or requires user interaction.

If it fails, the fallback is generating a MakeCode share URL instead of an SVG.

### Spike 2 — Hex file interception

Write a standalone Puppeteer script that:
1. Opens MakeCode in a headless tab
2. Injects TypeScript code
3. Triggers compilation
4. Intercepts the resulting `.hex` file binary without a real browser download

**Pass condition:** a valid `.hex` binary is captured programmatically.
**Fail condition:** compilation cannot be triggered or the binary cannot be intercepted headlessly.

If it fails, the fallback is returning a MakeCode share URL that the user can use to download the hex themselves.

Place spike scripts in `spike/` at the repo root. They are throwaway code — do not integrate them into the packages.

***

## Package: `makecode-mcp`

### Entry points

```json
{
  "exports": {
    "./browser": "./dist/browser/index.js",
    "./server": "./dist/server/index.js"
  }
}
```

Never import from `makecode-mcp/server` in browser code and vice versa. The build will enforce this but be explicit in your imports.

### `postMessage` protocol

The browser executor communicates with the MakeCode iframe via `postMessage`. The exact message types are defined by the `makecode-embed` library. Before implementing `IframeExecutor`, verify the correct message types from the `makecode-embed` source at:

https://github.com/microbit-foundation/makecode-embed

Key message types to confirm:
- Reading current code from the editor
- Writing/replacing code in the editor
- Accessing the blocks SVG
- Triggering hex compilation and receiving the binary

Wrap every `postMessage` call in a Promise with a timeout. Never leave a hanging listener. Use a correlation ID or message type guard to match responses to requests.

### React component

`MakeCodePanel` is a React component that wraps `makecode-embed`. It must:
- Accept an `onExecutorReady(executor: IframeExecutor) => void` callback prop
- Expose nothing else about its internal iframe to the host app
- Handle iframe load/unload lifecycle cleanly

### Puppeteer browser pool

`BrowserPool` manages one persistent Puppeteer browser process for the lifetime of the MCP server. It must:
- Launch lazily on first use, not at import time
- Expose a `withTab<T>(fn: (page: Page) => Promise<T>): Promise<T>` method
- Always close the tab in a `finally` block regardless of errors
- Never close the browser process itself (it stays alive between requests)
- Handle browser crashes by relaunching on next use

***

## Package: `app`

### WebLLM setup

The recommended model is **Qwen2.5-Coder 7B Instruct**. This requires WebGPU (Chrome 113+). Show a clear loading progress indicator on first load — the model is ~4–5GB and is cached in the browser's Cache API after the first download.

If WebGPU is not available, show a clear error message. Do not silently fall back to a CPU path without warning the user about performance implications.

### Tool-call loop

The LLM may return `finish_reason: "tool_calls"` multiple times before producing a final text response. The loop must handle this correctly:

1. Send message to WebLLM with tools array
2. If response has `finish_reason: "tool_calls"`, execute all tool calls in parallel
3. Append the assistant tool-call message and all tool result messages to history
4. Re-send to WebLLM
5. Repeat until `finish_reason: "stop"`
6. Stream final text response to the chat UI

Do not truncate or drop tool-call messages from the history mid-loop. The full tool-call exchange must be present for the model to reason correctly.

### System prompt

The system prompt must tell the LLM:
- It is a micro:bit coding assistant
- The MakeCode editor is open on the right and maintains state across the conversation
- `set_code` followed by `get_blocks_svg` is a valid multi-turn pattern
- `get_blocks_svg_from_code` and `get_hex_file_from_code` are self-contained and do not affect the editor
- Code should be valid MakeCode TypeScript (not standard Node.js TypeScript)

***

## What Not To Do

- Do not use `localStorage` or `sessionStorage` — the app may be served in contexts where storage is blocked. Use in-memory state only.
- Do not add a backend server or API proxy. Everything must run from static files.
- Do not share executor state between multiple chat sessions. Each page load is a fresh session.
- Do not register browser-only tools in the MCP server.
- Do not skip the Phase 1 spike before implementing server-side tools.
- Do not duplicate tool schema definitions. They live in `shared/tools.ts` only.

***

## Open Questions (resolve before implementing affected code)

1. **Exact `postMessage` message types** for `makecode-embed` — check the library source before implementing `IframeExecutor`.
2. **Blocks SVG accessibility** — determined by Phase 1 Spike 1.
3. **Hex interception** — determined by Phase 1 Spike 2.
4. **MCP transport** — SSE (Claude.ai, remote) vs stdio (Claude Desktop, local). May need both. Decide before implementing `McpServer`.
5. **WebLLM model size tolerance** — confirm whether the ~4–5GB first-load for Qwen2.5-Coder 7B is acceptable, or whether Phi-3.5 Mini (~2GB) should be the default.