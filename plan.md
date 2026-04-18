# MakeCode MCP — Implementation Plan

## Overview

A monorepo containing two packages:

- **`makecode-mcp`** — a TypeScript library that owns all MakeCode integration logic. It can operate as an in-browser React component or as a standalone Node.js MCP server.
- **`app`** — a React + Vite web application with a split-pane UI: LLM chat on the left (WebLLM, fully in-browser) and the MakeCode editor on the right.


## Decisions (2026-04-18)

- **Target user**: classroom (educators / students). POC-stage, so a large, capable model (Qwen2.5-Coder 7B Instruct, ~4–5GB first load) is acceptable for v1. Model-size optimisation is a post-POC concern. WebLLM gates `tools` behind an allowlist and only auto-applies its Hermes-2-Pro transformation to `Hermes-2-Pro-*` IDs; Qwen is made to work by patching the allowlist and applying the same grammar-constrained JSON-array transformation manually in `webllm-engine.ts`.
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

- Powered by WebLLM running fully in-browser on WebGPU (model: Qwen2.5-Coder 7B Instruct, ~4–5GB cached after first load; tool-calling enabled by applying Hermes-2-Pro's grammar-constrained JSON-array transformation manually)
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

### Phase 3 — `app` ✅

1. Scaffold React + Vite app — `packages/app/{vite.config.ts,index.html,src/main.tsx}`
2. Build split-pane layout — `src/App.tsx` grid: chat pane (35%) + editor pane (65%)
3. Integrate `MakeCodePanel` — wired via `onExecutorReady` callback into a ref
4. Integrate WebLLM with tool-call loop — `src/chat/{webllm-engine.ts,tool-loop.ts}`; `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC`; OpenAI-compatible streaming with parallel tool dispatch and a max-steps cap
5. Wire executor to chat panel — `createChatAdapter({ completion, getExecutor })` in `src/chat/adapter.ts`; no shared state or event bus, executor passed only via the adapter dep
6. End-to-end test — `test/chat.e2e.ts`: scripted transcript (`start_session` → `set_code` → `get_blocks_svg` → text reply) via `window.__mockChatCompletion` injected by Playwright
7. WebGPU gate + model-loading overlay — `LoadOverlay` renders unsupported / loading / error states; Qwen 7B is ~4–5 GB on first run

Unit tests (Vitest): `test/system-prompt.test.ts`, `test/tool-loop.test.ts` (parallel calls, error propagation, max-steps, history shape). All written before implementation.

Use `assistant-ui` to create the Chat interface.
Read the docs, this is very important: https://www.assistant-ui.com/docs

The chat interface is built using assistant-ui with a LocalRuntime backed by a custom ChatModelAdapter.
The adapter implements a single run() async generator function that receives the full conversation message history and an abort signal, then calls WebLLM's engine.chat.completions.create() with stream: true, yielding incremental text chunks back to the runtime as they arrive.
WebLLM runs entirely in the browser using WebGPU acceleration (with WASM as fallback), so no server is involved.
The adapter is instantiated via useLocalRuntime(adapter) and passed to AssistantRuntimeProvider, which wraps the editor shell.
Inside that provider, <Thread /> is placed as a React component in the chat panel of the split-pane layout — it is a pure UI component with no routing or global state assumptions, making it trivially embeddable inside a larger editor.
Editor context (the current MakeCode program) is injected into every inference call by prepending a system message or user context block inside the adapter's run() function before the messages are forwarded to WebLLM.
MakeCode MCP actions (get code, set code, run simulator, etc.) are registered as tools via assistant-ui's built-in tool calling API, so the LLM can invoke them mid-conversation and the runtime handles the human-in-the-loop approval flow automatically.

### Phase 4 — `makecode-mcp` server target

1. ✅ Implement `BrowserPool`, `TabPool`/`PuppeteerTabPool`, and `TabExecutor` (session-scoped tabs); both SVG and hex go through Puppeteer. `BrowserPool` is typed against a minimal `PageLike`/`BrowserLauncher` so it's unit-testable without a real browser; `TabExecutor` takes a `TabPool` so session logic is unit-testable without Puppeteer.
2. ✅ Implement `McpServer` — low-level `Server` from `@modelcontextprotocol/sdk` with an 8-entry dispatch table sourced from `shared/tools.ts`. `SessionError` is surfaced as a structured `isError` content block with the original code. Not using high-level `McpServer` because its `inputSchema` is zod-only and would duplicate our JSON-schema tool defs.
3. ✅ Stdio CLI entrypoint — `bin.ts` launches headless Puppeteer, wires `PuppeteerTabPool` → `TabExecutor` → `buildMcpServer`, disposes on SIGINT/SIGTERM. Registered as the `makecode-mcp` bin.
4. Pending — manual smoke test with Claude Desktop or MCP Inspector.
5. Pending — end-to-end test: Claude generates code → `get_blocks_svg_from_code` returns SVG → displayed in Claude chat.

Shell page: served by an ephemeral local HTTP server (`src/server/shell/shell-server.ts`) that bundles `shim.ts` with esbuild on first use and caches it. `shim.ts` wraps `MakeCodeFrameDriver` + `createMakeCodeRenderBlocks` and exposes `window.__mkcp`. `PuppeteerDriver` implements `MakeCodeDriver` as `page.evaluate` calls against that API.

Shared extraction: default MakeCode project files (`pxt.json` with `preferredEditor: "tsprj"`, `main.blocks`, `README.md`) and the empty-editor error message live in `src/shared/project-defaults.ts` and are used by `IframeExecutor`, `TabExecutor`, and the server shim.

***

## Open Questions

1. **[decided]** Blocks SVG accessibility — resolved by Spike 1: `createMakeCodeRenderBlocks` from `@microbit/makecode-embed/vanilla` works headlessly.
2. **[decided]** Hex interception via Puppeteer — resolved by Spike 2: `MakeCodeFrameDriver` + `onDownload` works with `controller=2`.
3. **[open]** `start_session` / `end_session` semantics on the browser target — no-op vs editor reset on start; clear editor on end. Decide in Phase 2.
4. **[decided for v1]** MCP transport — stdio is implemented in `bin.ts` (targets Claude Desktop / MCP Inspector). SSE/streamable HTTP deferred; the SDK supports it so adding a second transport is a thin wrapper around `buildMcpServer(...)`.
