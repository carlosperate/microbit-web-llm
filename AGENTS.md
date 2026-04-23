# AGENTS.md

This file provides context and instructions for AI agents working on this repository.

## Project Summary

This is a monorepo for **MakeCode MCP** — a TypeScript library and companion web app that connects an in-browser LLM chat to a MakeCode micro:bit editor.

The repo has two packages:

- **`packages/makecode-mcp`** — the core library. Owns all MakeCode integration. Has two build targets: `browser` (React + postMessage) and `server` (Node.js + Puppeteer + MCP protocol).
- **`packages/app`** — a React + Vite web app. Split-pane UI: WebLLM chat on the left, MakeCode iframe on the right.

Read `plan.md` for the roadmap, current phase, tool table, and open questions.


## Monorepo Setup

```bash
npm install                         # install all workspace dependencies
npm run build --workspaces          # build all packages
npm run test --workspaces           # run unit tests (Vitest); no-op until Phase 2
npm run test:e2e                    # run Playwright e2e tests; available from Phase 2
npm run dev -w app                  # run the app in dev mode; available from Phase 3
npm run dev:test-mcp -w makecode-mcp # build + launch MCP Inspector against the stdio server
```

Package manager: **npm workspaces**. Do not use pnpm or yarn.

TypeScript project references are used across packages. Run `npm run build --workspaces` before running the app if you've changed `makecode-mcp`.


## Key Architectural Rules

### Two executors, two interfaces — the iframe *is* the session on browser

The library has two executor interfaces in `src/shared/types.ts`, chosen to match how each target is actually used:

- **`BrowserExecutor`** (6 methods, no `session_id` anywhere) — one iframe per executor instance. The iframe itself is the session: its editor state persists for the lifetime of the instance. App developers create one `IframeExecutor` per MakeCode panel and hand it to the chat runtime. Tool calls are stateless from the LLM's perspective — no `start_session` / `end_session` ceremony.
- **`ServerExecutor`** (8 methods, stateful methods take `session_id`) — one MCP process can serve many LLM clients at once, each holding an opaque `session_id` that maps to a dedicated Puppeteer tab. `start_session` opens a tab; `end_session` closes it.

If you add a new tool, implement it on both interfaces. The shared tool schemas in `src/shared/tools.ts` are split into `browserTools` (6) and `serverTools` (8) — keep descriptions consistent across both where the behaviour is the same.

### Tool availability

Both targets expose the same core operations, but `get_hex_file_from_code` is server-only. The `makecode-embed` library exposes a blocks renderer (`createMakeCodeRenderBlocks`) but no equivalent stateless compile path; implementing one in the browser would require a hidden editor iframe or mutating the main editor — both violate the pure-function contract. On the browser target, `get_hex_file_from_code` throws a descriptive error directing callers to use `set_code` + `get_hex_file` instead. On the server target, `start_session` / `end_session` gate the stateful tools; `_from_code` variants are session-less on both targets.

### The `_from_code` variants are pure functions

`get_blocks_svg_from_code` and `get_hex_file_from_code` take TypeScript code as an argument and return an artifact. They must not read or write any persistent editor state. Treat them as stateless — same input always produces the same output.

### `get_blocks_svg` requires loaded code

In browser executor, `getBlocksSvg()` must check that the editor is not empty before proceeding. If it is empty, throw an `Error` with a message written for the LLM to read and self-correct:

```
No code loaded in the editor. Call set_code first to load code before requesting get_blocks_svg.
```

Do not throw a generic error. The message is part of the LLM interaction loop.

### Tests are written first

Every new piece of production code lands with a failing test authored *before* the implementation. Red → green → refactor. Writing tests after the fact overfits them to whatever the code happens to do, masking wrong behaviour. Unit tests (Vitest) live under `packages/*/test/`; integration/e2e tests (Playwright) live under the same `test/` tree but run only via `npm run test:e2e`. Spike scripts are exempt — their self-assertions are their tests.

### No shared state between chat and editor panels

The only connection between `ChatPanel` and `MakeCodePanel` in the app is the `IframeExecutor` instance passed as a prop. Do not introduce a global store, context, or event bus for this. Keep it a direct dependency.

### Verbose logging is part of the contract

This is a POC for teaching and research; a live trace of what the system is doing is how the developer (and student observers) debug it. Logging is enabled by default and must stay that way.

- Use the shared logger from `packages/makecode-mcp/src/shared/logger.ts`. Import via `makecode-mcp/browser` or `makecode-mcp/server` — never hand-roll `console.log` prefixes or instantiate a second logger.
- One namespace per module: `const log = createLogger("tool-loop")`. Pick a short, stable, hyphenated name. Existing namespaces include `app`, `adapter`, `tool-loop`, `webllm`, `panel`, `executor`, `mcp`, `tab-executor` — reuse these when extending the same area.
- Log the lifecycle events a reader needs to follow the flow: entry/exit of a run, each tool-loop step with `finish_reason` and pending-call count, every tool dispatch with args summary + result size, stall detection and recovery, errors. If you add a new tool case, log both the request and the result.
- Use `preview(value, maxChars?)` for anything that can be large (code, SVG, hex, JSON blobs). Never dump raw multi-kB strings to the console.
- Use `log.time(label)` (returns an end-fn) to instrument any async boundary a user might suspect of hanging — model load, tool dispatch, completion stream.
- Use `log.group(...)` / `log.groupEnd()` to bracket a self-contained unit of work (a `run()` turn, a `runToolLoop` invocation). Always pair them in a `try/finally` so a thrown error does not leave an open group.
- Server code (anything under `packages/makecode-mcp/src/server/`) must not write to stdout — the MCP stdio transport owns it. The shared logger already routes Node output to stderr; use it instead of `console.log`.
- Disable paths, for reference (do not remove these): `localStorage.setItem('mkcp:log','0')` or `?mkcp-log=0` in the browser; `MKCP_LOG=0` in Node; auto-off when `VITEST` / `NODE_ENV=test` is set so tests stay quiet. If you find yourself tempted to silence a specific log to pass a test, fix the test instead — the logger is already test-silent.

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

### Always use `@microbit/makecode-embed`

All MakeCode iframe integration — browser executor, server executor Puppeteer code, spike scripts, manual test pages — must use the `@microbit/makecode-embed` library (published as `@microbit/makecode-embed` on npm; source: https://github.com/microbit-foundation/makecode-embed). Never hand-roll the `postMessage` protocol. For non-React contexts use the `./vanilla` export (`MakeCodeFrameDriver`, `createMakeCodeRenderBlocks`); for React use `./react`. If a feature seems to require dropping to raw postMessage, check the library first — the answer is almost always there.

### React component

`MakeCodePanel` is a React component that wraps `@microbit/makecode-embed/react`. It must:
- Accept an `onExecutorReady(executor: BrowserExecutor) => void` callback prop (typed as the interface, not the concrete class)
- Expose nothing else about its internal iframe to the host app
- Handle iframe load/unload lifecycle cleanly, including calling `dispose()` on the adapter on unmount

The executor is bound to the panel's iframe for its lifetime. Editor state (the loaded code) lives in the iframe, so the same `IframeExecutor` instance across turns sees the same code — no session plumbing needed from the host app.

### Puppeteer browser pool

`BrowserPool` manages one persistent Puppeteer browser process for the lifetime of the MCP server. It must:
- Launch lazily on first use, not at import time
- Expose a `withTab<T>(fn: (page: PageLike) => Promise<T>): Promise<T>` method
- Always close the tab in a `finally` block regardless of errors
- Never close the browser process itself (it stays alive between requests)
- Handle browser crashes by relaunching on next use

`BrowserPool` is deliberately typed against a minimal `PageLike` (`close`/`goto`/`evaluate`) and a `BrowserLauncher` callback so it can be unit-tested with doubles. Puppeteer is only wired in at `bin.ts` and `PuppeteerTabPool`.

### Server target layering

```
bin.ts (CLI)
  └── buildMcpServer({ executor })                    ← src/server/mcp-server.ts
        └── TabExecutor (implements MakeCodeExecutor) ← src/server/tab-executor.ts
              └── TabPool (interface)                 ← src/server/tab-pool.ts
                    └── PuppeteerTabPool              ← src/server/puppeteer-tab-pool.ts
                          ├── BrowserPool             ← src/server/browser-pool.ts
                          ├── PuppeteerDriver         ← src/server/puppeteer-driver.ts
                          └── startShellServer()      ← src/server/shell/shell-server.ts
```

`TabExecutor` (implements `ServerExecutor`) owns session lifecycle and delegates every per-session operation to a `MakeCodeDriver` exposed by a `TabHandle`. `TabPool` is the seam that makes `TabExecutor` unit-testable without Puppeteer. `PuppeteerTabPool` is the only concrete implementation today.

### MCP server shell

The MCP server serves a static shell page to every Puppeteer tab from a local HTTP server started by `startShellServer()`:

- `src/server/shell/shell.html` — one `<iframe id="mk">` and a `<script type="module" src="/shim.js">`.
- `src/server/shell/shim.ts` — runs inside the shell page, wraps `MakeCodeFrameDriver` + `createMakeCodeRenderBlocks`, and exposes `window.__mkcp` (`importProject`, `saveProject`, `compile`, `renderBlocks`).
- `src/server/shell/shell-server.ts` — reads `shell.html` and bundles `shim.ts` with esbuild on first use (cached for the process lifetime), then serves both on `http://127.0.0.1:<ephemeral>`.

`PuppeteerDriver` implements `MakeCodeDriver` purely as `page.evaluate` calls against `window.__mkcp`. Do not add more IPC surface (e.g., `page.exposeFunction`) unless a tool genuinely cannot be expressed as a single evaluate call.

### MCP tool dispatch

`src/server/mcp-server.ts` uses the low-level `Server` class from `@modelcontextprotocol/sdk` and keeps an 8-entry `dispatch` table at module scope mapping tool name → `(executor, args) => Promise<unknown>`. `ListTools` is generated from `serverTools` in `shared/tools.ts` (the single source of truth for schemas). `SessionError` is translated into `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error, code }) }] }` so LLMs can distinguish `missing` / `unknown` / `expired` sessions from arbitrary failures.

We deliberately do **not** use the high-level `McpServer`: it requires zod `inputSchema`, and our tool schemas are JSON Schema (shared with the OpenAI-compatible browser path). The deprecation warning on `Server` is an accepted tradeoff.

### CLI entrypoint

`bin.ts` (registered as the `makecode-mcp` bin) wires `PuppeteerTabPool` → `TabExecutor` → `buildMcpServer` → `StdioServerTransport`, and disposes the executor on SIGINT/SIGTERM. The server is a standard stdio MCP server — point Claude Desktop / MCP Inspector at `node dist/server/bin.js` (or `npx makecode-mcp` once installed).

For local manual testing, run `npm run dev:test-mcp -w makecode-mcp`. This builds the package and launches the MCP Inspector (`npx @modelcontextprotocol/inspector`) wired to `node dist/server/bin.js`. See https://modelcontextprotocol.io/docs/tools/inspector for the Inspector UI.

### Shared project defaults

Default MakeCode project files (`pxt.json` with `preferredEditor: "tsprj"`, `main.blocks`, `README.md`) and the empty-editor error message live in `src/shared/project-defaults.ts` as `fillProjectDefaults(text, code)` and `EMPTY_EDITOR_ERROR`. Both executors and the server shim import from here — do not re-declare these constants in new code.

## Package: `app`

### WebLLM setup

The app ships with a user-selectable model picker (`MODELS` in `webllm-engine.ts`). Two options are offered:

- **Qwen2.5-Coder 7B Instruct** (`Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC`) — default. Coder-tuned, strong on MakeCode TypeScript. Not on WebLLM's built-in function-calling allowlist, so `webllm-engine.ts` patches `functionCallingModelIds` and applies the Hermes-2-Pro transformation manually: inject the Hermes-2-Pro system prompt with tool definitions, constrain output with the function-call JSON-array `response_format` schema, and parse the streamed JSON into synthetic `tool_calls` deltas. When the schema-constrained output is `[]`, `tool-loop.ts` makes one follow-up call with `tools: []` so the model can stream a plain-text reply.
- **Hermes-3 Llama 3.1 8B** (`Hermes-3-Llama-3.1-8B-q4f16_1-MLC`) — native path. Already on WebLLM's allowlist; we pass `tools` straight through and let WebLLM handle it. Detected via `needsManualTransform()` which treats anything not starting with `Hermes-` as needing the manual transform.

The dropdown shows short labels (`Qwen2.5-Coder 7B`, `Hermes-3 8B`); the full descriptive label appears in the loading overlay while the download runs. A **Load model** button next to the dropdown triggers the download explicitly; while loading it is disabled and the composer input + send button are disabled with a "Load a model to begin" notice in the thread viewport. When the selected model finishes loading, the button is replaced by a "model loaded" pill. If the user changes the dropdown after loading, the pill flips back to the button so they can load the new choice.

Changing models **resets the chat**. The chat subtree (`ChatThread`) owns its own `useLocalRuntime` and is keyed on a `chatEpoch` counter that bumps each time a model finishes loading — remounting it yields a fresh, empty thread. `MakeCodePanel` lives above that boundary, so the iframe, its loaded code, and any open MakeCode session persist across model switches.

This requires WebGPU (Chrome 113+). Show a clear loading progress indicator on first load — the model is ~4–5 GB and is cached in the browser's Cache API after the first download.

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

The loop also handles Qwen-specific quirks:
- **Empty `tool_calls` as done-signal** — when `finish_reason === "tool_calls"` but no calls were produced (the schema-constrained model emitted `[]`), the loop makes one follow-up call with `tools: []` to let the model stream a plain-text reply, then returns. This never recurses.
- **Stall-before-substantive-work recovery** — grammar-constrained `[]` is always a valid emission, and in practice Qwen sometimes emits it on turn 1 without calling any tool — describing the tool workflow inside a TypeScript code block instead. Before falling back to the plain-text branch, `runToolLoop` checks whether the history has any *substantive* call yet (`set_code`, `get_current_code`, `get_blocks_svg`, `get_hex_file`, or the `_from_code` variants). If not, it appends a `STALL_REMINDER` system message and retries once with tools still enabled. Only if the stall persists does it fall back to plain text. The retry fires at most once per run (`stallRetried` flag). The cost is one extra inference on purely conversational queries that correctly emit `[]` — bounded and acceptable for the reliability gain on actionable queries.

Because the browser target has no sessions, the loop is stateless: no `session_id` injection, no next-step hint enrichment, no ordering of a setup call before siblings. If you add a new tool, just add a case to the `dispatchTool` switch.

### System prompt

The system prompt must tell the LLM:
- It is a micro:bit coding assistant
- The MakeCode editor on the right is stateful across the conversation — code loaded via `set_code` persists for later calls like `get_blocks_svg` and `get_hex_file`
- `set_code` followed by `get_blocks_svg` is a valid multi-turn pattern
- `get_blocks_svg_from_code` is self-contained — use it to preview a snippet without touching the editor
- Code should be valid MakeCode TypeScript (not standard Node.js TypeScript)

The browser prompt must not mention `start_session` / `end_session` / `session_id` — those belong to the server target and are irrelevant here.


## What Not To Do

- Do not add a backend server or API proxy. Everything must run from static files.
- Do not share executor state between multiple chat sessions. Each page load is a fresh session.
- Do not duplicate tool schema definitions. They live in `shared/tools.ts` only.
- Do not duplicate MakeCode project defaults. They live in `shared/project-defaults.ts` only.
