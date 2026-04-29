# AGENTS.md

This file provides context and instructions for AI agents working on this repository.

## Project Summary

This is a monorepo for **MakeCode MCP** — a TypeScript library and companion web app that connects an in-browser LLM chat to a MakeCode micro:bit editor.

The repo has two packages:

- **`packages/makecode-mcp`** — the core library. Owns all MakeCode integration. Has two build targets: `browser` (React + postMessage) and `server` (Node.js + Puppeteer + MCP protocol).
- **`packages/app`** — a React + Vite web app. Split-pane UI: WebLLM chat on the left, MakeCode iframe on the right.

Use `README.md` for monorepo setup and package overviews, and `packages/makecode-mcp/README.md` for MCP client configuration and server usage details.


## Monorepo Setup

```bash
npm install                         # install all workspace dependencies
npm run build --workspaces          # build all packages
npm run test --workspaces           # run unit tests (Vitest)
npm run test:e2e                    # run Playwright e2e tests
npm run dev -w app                  # run the app in dev mode
npm run dev:test-mcp -w makecode-mcp # build + launch MCP Inspector against the stdio server
```

Package manager: **npm workspaces**. Do not use pnpm or yarn.

TypeScript project references are used across packages. Run `npm run build --workspaces` before running the app if you've changed `makecode-mcp`.


## Key Architectural Rules

### Two executors, two interfaces — the iframe *is* the session on browser

The library has two executor interfaces in `src/shared/types.ts`, chosen to match how each target is actually used:

- **`BrowserExecutor`** (5 methods, no `session_id` anywhere) — one iframe per executor instance. The iframe itself is the session: its editor state persists for the lifetime of the instance. App developers create one `IframeExecutor` per MakeCode panel and hand it to the chat runtime. Tool calls are stateless from the LLM's perspective — no `start_session` / `end_session` ceremony.
- **`ServerExecutor`** (8 methods, stateful methods take `session_id`) — one MCP process can serve many LLM clients at once, each holding an opaque `session_id` that maps to a dedicated Puppeteer tab. `start_session` opens a tab; `end_session` closes it.

If a new tool makes sense on both targets, implement it on both interfaces. The shared tool schemas in `src/shared/tools.ts` are split into `browserTools` (5) and `serverTools` (8) — they are deliberately not symmetric, so keep descriptions consistent across both where the behaviour is the same and let them diverge where the targets actually differ.

### Tool availability

Both targets expose the same core operations, but `get_hex_file_from_code` is server-only. The `makecode-embed` library exposes a blocks renderer (`createMakeCodeRenderBlocks`) but no equivalent stateless compile path; implementing one in the browser would require a hidden editor iframe or mutating the main editor — both violate the pure-function contract. The browser target therefore omits `get_hex_file_from_code` entirely from `browserTools` and from `BrowserExecutor` rather than advertising a tool that always throws — the system prompt directs the model toward `set_code` + `get_hex_file` instead. On the server target, `start_session` / `end_session` gate the stateful tools; `_from_code` variants are session-less on both targets.

### The `_from_code` variants are pure functions

`get_blocks_image_from_code` and `get_hex_file_from_code` take TypeScript code as an argument and return an artifact. They must not read or write any persistent editor state. Treat them as stateless — same input always produces the same output.

### `get_blocks_image` requires loaded code

In browser executor, `getBlocksImage()` must check that the editor is not empty before proceeding. If it is empty, throw an `Error` with a message written for the LLM to read and self-correct:

```
No code loaded in the editor. Call set_code first to load code before requesting get_blocks_image.
```

Do not throw a generic error. The message is part of the LLM interaction loop.

### `set_code` merges workspacesave events and surfaces decompile failures

`MakeCodeFrameDriverAdapter.setProject` does two things beyond calling `importProject`, both motivated by failure modes that hit the LLM tool loop hard:

1. **Merge workspacesave events into the cache instead of replacing.** MakeCode fires `workspacesave` events with partial `text` (e.g. only `main.blocks` after a view switch following `importProject`). Replacing `latestFiles.text` wholesale would drop the `main.ts` we just imported and make the next `getBlocksImage` throw `EMPTY_EDITOR_ERROR`. Combined with sequential tool dispatch in the chat tool loop (so a fast read can't outrun a slow `setCode`), the optimistic cache update at the top of `setProject` plus this merge is enough — there's no echo-wait state machine.
2. **Propagate `switchBlocks` rejection.** Importing with an empty `main.blocks` lands the editor in JS view; `switchBlocks` then forces decompile-to-blocks. If the TS is invalid, MakeCode shows its own error popup *and* `switchBlocks` rejects. The adapter rethrows that rejection from `setProject` with a message the model can act on (`"Code was loaded into the editor but failed to compile to blocks: <reason>. Fix the TypeScript and call set_code again."`). The tool loop surfaces this as `isError: true` so the model self-corrects rather than calling `get_blocks_image` on uncompilable code.

### Tests are written first

Every new piece of production code lands with a failing test authored *before* the implementation. Red → green → refactor. Writing tests after the fact overfits them to whatever the code happens to do, masking wrong behaviour. Unit tests (Vitest) live under `packages/*/test/`; integration/e2e tests (Playwright) live under the same `test/` tree but run only via `npm run test:e2e`. Spike scripts are exempt — their self-assertions are their tests.

### No shared state between chat and editor panels

The only connection between `ChatPanel` and `MakeCodePanel` in the app is the `IframeExecutor` instance passed as a prop. Do not introduce a global store, context, or event bus for this. Keep it a direct dependency.

### Verbose logging is part of the contract

This is a POC for teaching and research; a live trace of what the system is doing is how the developer (and student observers) debug it. Logging is enabled by default and must stay that way.

- Use the shared logger from `packages/makecode-mcp/src/shared/logger.ts`. Import via `makecode-mcp/browser` or `makecode-mcp/server` — never hand-roll `console.log` prefixes or instantiate a second logger.
- One namespace per module: `const log = createLogger("tool-loop")`. Pick a short, stable, hyphenated name. Existing namespaces include `app`, `adapter`, `tool-loop`, `webllm`, `panel`, `executor`, `mcp`, `tab-executor` — reuse these when extending the same area.
- Log the lifecycle events a reader needs to follow the flow: entry/exit of a run, each tool-loop step with `finish_reason` and pending-call count, every tool dispatch with args summary + result size, stall detection and recovery, errors. If you add a new tool case, log both the request and the result.
- Use `preview(value, maxChars?)` for anything that can be large (code, PNG base64, hex, JSON blobs). Never dump raw multi-kB strings to the console.
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

- `src/server/shell/shell.html` — one `<iframe id="mk">` and a `<script type="module" src="/shim.js">`. Used for sessions and `getHexFileFromCode`.
- `src/server/shell/shim.ts` — runs inside the shell page, wraps `MakeCodeFrameDriver` + `createMakeCodeRenderBlocks`, and exposes `window.__mkcp` (`importProject`, `saveProject`, `compile`, `renderBlocks`).
- `src/server/shell/render.html` + `src/server/shell/render-shim.ts` — render-only page (no editor iframe) that loads `createMakeCodeRenderBlocks` and exposes `window.__mkcp_render.renderBlocksImage`. `PuppeteerTabPool` keeps a single persistent render tab on this page so `getBlocksImageFromCode` is near-instant — it never pays the cost of loading makecode.microbit.org.
- `src/server/shell/shell-server.ts` — reads both HTML files and bundles both shims with esbuild on first use (cached for the process lifetime), then serves them on `http://127.0.0.1:<ephemeral>`.

`PuppeteerDriver` implements `MakeCodeDriver` purely as `page.evaluate` calls against `window.__mkcp`. Do not add more IPC surface (e.g., `page.exposeFunction`) unless a tool genuinely cannot be expressed as a single evaluate call.

### MCP tool dispatch

`src/server/mcp-server.ts` uses the high-level `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and registers each tool with `server.registerTool(name, { description, inputSchema }, handler)`. The single source of truth is `serverToolMeta` in `shared/tools.ts` — Zod raw shapes + descriptions. `McpServer` consumes the shapes directly; `serverTools` (JSON Schema descriptors used by tests and the browser-shaped path) are derived from the same shapes via `z.toJSONSchema(z.strictObject(shape))` so the two views can never drift.

Each handler is wrapped in a `safe(name, fn)` helper that catches `SessionError` and arbitrary errors and returns `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error, code }) }] }`. Without this wrapper `McpServer` would surface a thrown error as a transport-level error, losing the session-code taxonomy (`missing` / `unknown` / `expired`) that LLMs use to self-correct.

### CLI entrypoint

`bin.ts` (registered as the `makecode-mcp` bin) wires `PuppeteerTabPool` → `TabExecutor` → `buildMcpServer` → `StdioServerTransport`, and disposes the executor on SIGINT/SIGTERM. The server is a standard stdio MCP server — point Claude Desktop / MCP Inspector at `node dist/server/bin.js` (or `npx makecode-mcp` once installed).

For local manual testing, run `npm run dev:test-mcp -w makecode-mcp`. This builds the package and launches the MCP Inspector (`npx @modelcontextprotocol/inspector`) wired to `node dist/server/bin.js`. See https://modelcontextprotocol.io/docs/tools/inspector for the Inspector UI.

### Shared project defaults

Default MakeCode project files (`pxt.json` with `preferredEditor: "tsprj"`, `main.blocks`, `README.md`) and the empty-editor error message live in `src/shared/project-defaults.ts` as `fillProjectDefaults(text, code)` and `EMPTY_EDITOR_ERROR`. Both executors and the server shim import from here — do not re-declare these constants in new code.

## Package: `app`

### WebLLM setup

The app ships with a user-selectable model picker (`MODELS` in `webllm-engine.ts`). The current options are:

- **Qwen2.5-Coder 7B Instruct** (`Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC`) — default. Coder-tuned, strong on MakeCode TypeScript.
- **Hermes-3 Llama 3.1 8B** (`Hermes-3-Llama-3.1-8B-q4f16_1-MLC`).
- **Qwen3 8B** (`Qwen3-8B-q4f16_1-MLC`).
- **Llama-3.1 8B Instruct** (`Llama-3.1-8B-Instruct-q4f16_1-MLC`).

All models share the same tool-calling path in `webllm-engine.ts`: inject a system prompt describing the tools, grammar-constrain output via `response_format` to a JSON array of `{name, arguments}` objects, and parse the streamed JSON into synthetic `tool_calls` deltas. When the schema-constrained output is `[]`, `tool-loop.ts` makes one follow-up call with `tools: []` so the model can stream a plain-text reply. To add a new model, append a `{ id, shortLabel, label }` entry to `MODELS` — no engine changes required.

WebLLM's built-in Hermes-2-Pro native path is deliberately bypassed. Its injected prompt omits the `<tool_call></tool_call>` wrapper instruction Hermes-3 was trained on, so Hermes-3 emits bare JSON or markdown that WebLLM's parser then rejects. Owning the prompt and parser end-to-end gives reliable behaviour across every model in the picker.

The dropdown shows each model's `shortLabel`; the full `label` appears in the loading overlay while the download runs. A **Load model** button next to the dropdown triggers the download explicitly; while loading it is disabled and the composer input + send button are disabled with a "Load a model to begin" notice in the thread viewport. When the selected model finishes loading, the button is replaced by a "model loaded" pill. If the user changes the dropdown after loading, the pill flips back to the button so they can load the new choice.

Changing models **resets the chat**. The chat subtree (`ChatThread`) owns its own `useLocalRuntime` and is keyed on a `chatEpoch` counter that bumps each time a model finishes loading — remounting it yields a fresh, empty thread. `MakeCodePanel` lives above that boundary, so the iframe, its loaded code, and any open MakeCode session persist across model switches.

This requires WebGPU (Chrome 113+). Show a clear loading progress indicator on first load — the model is ~4–5 GB and is cached in the browser's Cache API after the first download.

If WebGPU is not available, show a clear error message. Do not silently fall back to a CPU path without warning the user about performance implications.

### Tool-call loop

The LLM may return `finish_reason: "tool_calls"` multiple times before producing a final text response. The loop must handle this correctly:

1. Send message to WebLLM with tools array
2. If response has `finish_reason: "tool_calls"`, execute all tool calls **sequentially in emission order** (not in parallel — see note below)
3. Append the assistant tool-call message and all tool result messages to history
4. Re-send to WebLLM
5. Repeat until `finish_reason: "stop"`
6. Stream final text response to the chat UI

Do not truncate or drop tool-call messages from the history mid-loop. The full tool-call exchange must be present for the model to reason correctly.

The loop also handles Qwen-specific quirks:
- **Empty `tool_calls` as done-signal** — when `finish_reason === "tool_calls"` but no calls were produced (the schema-constrained model emitted `[]`), the loop makes one follow-up call with `tools: []` to let the model stream a plain-text reply, then returns. This never recurses.
- **Stall-before-substantive-work recovery** — grammar-constrained `[]` is always a valid emission, and in practice Qwen sometimes emits it on turn 1 without calling any tool — describing the tool workflow inside a TypeScript code block instead. Before falling back to the plain-text branch, `runToolLoop` checks whether the history has any *substantive* call yet (`set_code`, `get_current_code`, `get_blocks_image`, `get_hex_file`, or the `_from_code` variants). If not, it appends a `STALL_REMINDER` system message and retries once with tools still enabled. Only if the stall persists does it fall back to plain text. The retry fires at most once per run (`stallRetried` flag). The cost is one extra inference on purely conversational queries that correctly emit `[]` — bounded and acceptable for the reliability gain on actionable queries.

Because the browser target has no sessions, the loop is stateless: no `session_id` injection, no next-step hint enrichment, no ordering of a setup call before siblings. If you add a new tool, just add a case to the `dispatchTool` switch.

Tool calls within a single batch are dispatched **sequentially** in the order the model emitted them. The smaller models in the picker frequently batch `get_current_code` + `set_code` + `get_blocks_image` in one turn intending strict ordering; running them in parallel races — a 17ms `get_blocks_image` returns before the ~2s `set_code` ingest commits, so blocks render against the pre-set state and throw `EMPTY_EDITOR_ERROR`. Inference cost dwarfs executor latency, so serialisation is essentially free. Do not reintroduce `Promise.all` here.

### System prompt

The system prompt must tell the LLM:
- It is a micro:bit coding assistant
- The MakeCode editor on the right is stateful across the conversation — code loaded via `set_code` persists for later calls like `get_blocks_image` and `get_hex_file`
- `set_code` followed by `get_blocks_image` is a valid multi-turn pattern (the PNG renders inline in the chat)
- `get_blocks_image_from_code` is self-contained — use it to preview a snippet without touching the editor
- Code should be valid MakeCode TypeScript (not standard Node.js TypeScript)

The browser prompt must not mention `start_session` / `end_session` / `session_id` — those belong to the server target and are irrelevant here.


## What Not To Do

- Do not add a backend server or API proxy. Everything must run from static files.
- Do not share executor state between multiple chat sessions. Each page load is a fresh session.
- Do not duplicate tool schema definitions. They live in `shared/tools.ts` only.
- Do not duplicate MakeCode project defaults. They live in `shared/project-defaults.ts` only.
