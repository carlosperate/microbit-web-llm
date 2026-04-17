# MakeCode MCP — Implementation Plan

## Overview

A monorepo containing two packages:

- **`makecode-mcp`** — a TypeScript library that owns all MakeCode integration logic. It can operate as an in-browser React component or as a standalone Node.js MCP server.
- **`app`** — a React + Vite web application with a split-pane UI: LLM chat on the left (WebLLM, fully in-browser) and the MakeCode editor on the right.


## Decisions (2026-04-18)

- **Target user**: classroom (educators / students). POC-stage, so a large, capable model (Qwen2.5-Coder 7B, ~4–5GB first load) is acceptable for v1. Model-size optimisation is a post-POC concern.
- **MCP server is in scope for v1** (not deferred).
- **Stateful tools are gated by explicit session lifecycle.** Two new tools — `start_session` and `end_session` — are added. All tools are available on both targets; stateful tools require an active session. The LLM is responsible for calling `start_session` before and `end_session` after. Exact semantics (browser no-op vs editor reset; server tab-per-session) finalised in Phase 2.


## Monorepo Structure

```
/
├── packages/
│   ├── makecode-mcp/
│   │   ├── src/
│   │   │   ├── shared/        ← Tool JSON schemas (used by both targets)
│   │   │   ├── browser/       ← IframeExecutor + React component
│   │   │   └── server/        ← PuppeteerExecutor + MCP server
│   │   ├── test/
│   │   │   ├── shared/        ← Unit tests for schemas / session validation
│   │   │   ├── browser/       ← Integration tests: real MakeCode iframe via Playwright
│   │   │   └── server/        ← Integration tests: BrowserPool + TabExecutor + MCP
│   │   ├── test-page/         ← Manual smoke-test Vite entry (Phase 2)
│   │   └── package.json       ← Two entry points: /browser and /server
│   └── app/
│       ├── src/
│       │   ├── chat/          ← WebLLM chat panel
│       │   └── App.tsx        ← Split-pane layout
│       ├── test/              ← Component tests (React Testing Library) + e2e (Playwright)
│       └── package.json
├── spike/                      ← Throwaway, not a workspace member
└── package.json
```


## Package: `makecode-mcp`

### Shared (`src/shared/`)

Defines the tool schemas as plain JSON-serialisable objects in OpenAI function-calling format. No runtime dependencies. Both the browser and server import from here.

**Tools:**

| Tool | Arguments | Returns | Session required |
|------|-----------|---------|------------------|
| `start_session` | none | `{ session_id: string }` | — |
| `end_session` | `session_id: string` | void | yes |
| `get_current_code` | `session_id: string` | TypeScript string | yes |
| `set_code` | `session_id: string, code: string` | void | yes |
| `get_blocks_svg` | `session_id: string` | SVG string | yes |
| `get_hex_file` | `session_id: string` | base64 string | yes |
| `get_blocks_svg_from_code` | `code: string` | SVG string | no |
| `get_hex_file_from_code` | `code: string` | base64 string | no |

All eight tools are registered by both targets. `start_session` returns an opaque `session_id` that the LLM must pass back on every subsequent stateful call. Stateful tools return a structured error if `session_id` is missing, unknown, or expired, directing the LLM to call `start_session` first.

Tool descriptions include explicit guidance for the LLM — for example, `get_blocks_svg` states that code must have been loaded via `set_code` first, and returns a descriptive error if the editor is empty.

### Browser (`src/browser/`)

**`IframeExecutor`** — implements all eight tools against a live MakeCode iframe by wrapping `@microbit/makecode-embed/vanilla`'s `MakeCodeFrameDriver` (and `createMakeCodeRenderBlocks` for the render-only path). Never hand-rolls `postMessage`.

**`MakeCodePanel`** — a React component built on `@microbit/makecode-embed/react`, exposing an `IframeExecutor` instance via an `onExecutorReady` callback prop. The host app mounts this component and gets back an executor it can pass to the chat panel.

Implementation notes:
- `set_code` / `get_code` → `MakeCodeFrameDriver` project APIs (`importProject`, `saveProject`)
- `get_blocks_svg` on loaded code → `driver.renderBlocks(...)` or a dedicated `createMakeCodeRenderBlocks` instance
- `get_hex_file` → `driver.compile()` + `onDownload` callback

### Server (`src/server/`)

**`BrowserPool`** — manages one persistent Puppeteer browser process. Exposes a `withTab(fn)` method that opens a fresh MakeCode tab, runs the callback, then closes the tab. The browser stays alive between calls.

**`TabExecutor`** — implements session-scoped state by keeping a Puppeteer tab open for the lifetime of the session. `start_session` allocates a tab, generates a `session_id` (UUID), stores `session_id → page` in an in-memory map, and returns the id. Subsequent stateful calls look up the page by `session_id`; unknown ids return a structured error. `end_session` closes the tab and evicts the entry. `_from_code` tools use a transient tab via `BrowserPool.withTab`. Idle sessions are evicted after a configurable TTL (default 30 min) to bound resource use.

On the **browser target**, `IframeExecutor` still honours the same protocol — `start_session` returns a `session_id` and all stateful tools validate it — but since there is only one iframe per page, the executor rejects any call whose `session_id` does not match the currently-active one. This keeps the tool contract identical across targets.

**`McpServer`** — sets up an MCP server using `@modelcontextprotocol/sdk` with SSE or stdio transport. Registers all eight tools and delegates execution to `TabExecutor`.

Key things to verify with a Puppeteer spike before committing to implementation:
- Whether blocks SVG is accessible in the DOM or requires a `postMessage` round-trip
- Whether hex compilation can be triggered programmatically and the binary intercepted


## Package: `app`

A standard React + Vite application. Imports `MakeCodePanel` and `IframeExecutor` from `makecode-mcp/browser`. Imports WebLLM from `@mlc-ai/web-llm`.

### Layout

Split-pane: chat panel on the left (~35% width), MakeCode editor on the right (~65% width). No persistence between sessions.

### Chat Panel

- Powered by WebLLM running fully in-browser on WebGPU (model: Qwen2.5-Coder 7B Instruct, ~4–5GB cached after first load)
- OpenAI-compatible function-calling API — the tool schemas from `makecode-mcp/shared` are passed directly as the `tools` array
- Agentic tool-call loop: the LLM may call multiple tools before producing a final text response
- System prompt injects context: the LLM is a micro:bit coding assistant, session lifecycle rules, the editor maintains state across the conversation while a session is open, `set_code` followed by `get_blocks_svg` is a valid multi-turn pattern
- Streaming token output

### Tool Execution in the App

The `MakeCodePanel` component exposes an `IframeExecutor`. The chat panel receives this executor and uses it to dispatch tool calls from the LLM. The only shared dependency between the two panels is this executor instance — no global state or event bus.

```
ChatPanel (WebLLM) ──tool call──► IframeExecutor ──postMessage──► MakeCode iframe
                   ◄──result─────                 ◄──message──────
```

## Testing Strategy

**Tests are written first.** For every phase task below that produces production code, the test is authored and committed in a failing state before the implementation. This is non-negotiable — writing tests after the fact causes the test to overfit to whatever the implementation happens to do, even when that behaviour is wrong. Red → green → refactor. A PR that adds code without a preceding (or same-PR leading) failing test will be rejected.

Tests live next to the code they cover, under a `test/` sibling of `src/` in each package. Two tiers:

**Unit tests** — **Vitest**, hoisted as a devDependency at the repo root. Cover pure logic: tool JSON schemas, session-id validation, MCP request/response shapes, tool-call loop state machine. Fast, no browser, no network. Run via `npm run test --workspaces`.

**Integration / e2e tests** — **Playwright**, also hoisted at the root.
- `makecode-mcp/test/browser/` — drives a real MakeCode iframe served from the test-page Vite entry and asserts each `IframeExecutor` tool end-to-end (set → get roundtrip, SVG render, hex compile).
- `makecode-mcp/test/server/` — spins up `BrowserPool` + `TabExecutor` + `McpServer` in-process, connects a test MCP client, and exercises the full tool surface including session lifecycle.
- `app/test/` — launches the Vite dev server and drives the full split-pane UI, mocking the WebLLM response to deterministic tool-call transcripts.

Playwright tests are gated behind `npm run test:e2e` (not the default `test` script) so unit tests stay fast in CI watch mode. Real MakeCode iframe tests tolerate network flakes via per-test retries.

Spike scripts in `spike/` are outside this structure — their self-assertions are their tests, and they are not run in CI.

***

## Implementation Phases

### Phase 1 — Docs Split + Scaffold + Spikes

Two spikes, both throwaway, gate the next phases. Findings and PASS/FAIL decisions are recorded in `spike/README.md`.

All spikes (and all production MakeCode integration) use `@microbit/makecode-embed` — the `./vanilla` export for non-React / Puppeteer contexts, the `./react` export for React. Never hand-roll `postMessage`.

#### Spike 1 — Blocks SVG extraction

Standalone Puppeteer script. Loads a small shell page that bundles `createMakeCodeRenderBlocks` from `@microbit/makecode-embed/vanilla`, calls `renderBlocks({ code: "basic.showString('hello')" })`, and asserts the returned SVG is well-formed.

**Pass condition:** a valid SVG string is returned (starts with `<svg`, contains `<g>` or `<path>`, > 200 bytes).
**Fail condition:** the renderer does not return an SVG, or fails to initialise headlessly.
**Fallback if fail:** generate a MakeCode share URL instead of an SVG.

#### Spike 2 — Hex file interception

Standalone Puppeteer script. Loads a shell page that bundles `MakeCodeFrameDriver` from `@microbit/makecode-embed/vanilla` with `controllerId: "spike"` and an `initialProjects` returning the sample code, calls `driver.compile()`, and captures the hex via the `onDownload({ name, hex })` callback.

**Pass condition:** a valid Universal Hex binary is captured (every line is a colon-prefixed hex record, 1KB–5MB).
**Fail condition:** compile does not fire `onDownload`, or the returned content is not a hex file.
**Fallback if fail:** return a MakeCode share URL that the user can use to download the hex themselves.

Spike scripts live in `spike/` at the repo root. They are throwaway code — not integrated into the packages.

### Phase 2 — `makecode-mcp` browser target

1. Implement `shared/tools.ts` — all eight tool schemas (incl. `start_session` / `end_session`)
2. Implement `IframeExecutor` — Promise-based `postMessage` wrapper
3. Implement `MakeCodePanel` React component
4. Build a **manual test page** at `packages/makecode-mcp/test-page/` — minimal HTML + Vite dev entry that mounts `MakeCodePanel` with a side panel of buttons (Start session, Set code via textarea, Get code, Get blocks SVG rendered inline, Get hex downloaded). Used for human smoke-testing the executor against real MakeCode before the app exists. Not part of the published bundle.
5. Write integration tests against a real MakeCode iframe

### Phase 3 — `app`

1. Scaffold React + Vite app
2. Build split-pane layout
3. Integrate `MakeCodePanel`
4. Integrate WebLLM with tool-call loop
5. Wire executor to chat panel
6. End-to-end test: user asks a question → LLM calls `set_code` → editor updates → LLM calls `get_blocks_svg` → SVG displayed in chat

### Phase 4 — `makecode-mcp` server target

1. Implement `BrowserPool` and `TabExecutor` (session-scoped tabs); both SVG and hex go through Puppeteer
2. Implement `McpServer`
3. Test with Claude Desktop or MCP Inspector
4. End-to-end test: Claude generates code → `get_blocks_svg_from_code` returns SVG → displayed in Claude chat

***

## Open Questions

1. **[decided]** Blocks SVG accessibility — resolved by Spike 1: `createMakeCodeRenderBlocks` from `@microbit/makecode-embed/vanilla` works headlessly.
2. **[decided]** Hex interception via Puppeteer — resolved by Spike 2: `MakeCodeFrameDriver` + `onDownload` works with `controller=2`.
3. **[open]** `start_session` / `end_session` semantics on the browser target — no-op vs editor reset on start; clear editor on end. Decide in Phase 2.
4. **[open]** MCP transport — SSE (for remote clients like Claude.ai) vs stdio (for local clients like Claude Desktop). May need to support both. Decide before Phase 4.
