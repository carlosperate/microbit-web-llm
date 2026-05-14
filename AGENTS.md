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

- **`BrowserExecutor`** (5 methods, no `session_id` anywhere) — one iframe per executor instance. The iframe itself is the session: its editor state persists for the lifetime of the instance. App developers create one `IframeExecutor` per MakeCode panel and hand it to the chat runtime. Tool calls are stateless from the LLM's perspective — no `session_start` / `session_end` ceremony.
- **`ServerExecutor`** (8 methods, stateful methods take `session_id`) — one MCP process can serve many LLM clients at once, each holding an opaque `session_id` that maps to a dedicated Puppeteer tab. `session_start` opens a tab; `session_end` closes it.

If a new tool makes sense on both targets, implement it on both interfaces. The shared tool schemas in `src/shared/tools.ts` are split into `browserTools` (5) and `serverTools` (8) — they are deliberately not symmetric, so keep descriptions consistent across both where the behaviour is the same and let them diverge where the targets actually differ.

### Tool availability

Both targets expose the same core operations, but `get_hex_file_from_code` is server-only. The `makecode-embed` library exposes a blocks renderer (`createMakeCodeRenderBlocks`) but no equivalent stateless compile path; implementing one in the browser would require a hidden editor iframe or mutating the main editor — both violate the pure-function contract. The browser target therefore omits `get_hex_file_from_code` entirely from `browserTools` and from `BrowserExecutor` rather than advertising a tool that always throws — the system prompt directs the model toward `session_set_code` + `session_get_hex_file` instead. On the server target, `session_start` / `session_end` gate the stateful tools; `_from_code` variants are session-less on both targets.

### The `_from_code` variants are pure functions

`get_blocks_img_from_code` and `get_hex_file_from_code` take TypeScript code as an argument and return an artifact. They must not read or write any persistent editor state. Treat them as stateless — same input always produces the same output.

### `session_get_blocks_img` requires loaded code

In browser executor, `getBlocksImage()` must check that the editor is not empty before proceeding. If it is empty, throw an `Error` with a message written for the LLM to read and self-correct:

```
No code loaded in the editor. Call session_set_code first to load code before requesting session_get_blocks_img.
```

Do not throw a generic error. The message is part of the LLM interaction loop.

### `session_set_code` confirms decompile and `session_get_code` always round-trips

`MakeCodeFrameDriverAdapter` is intentionally cache-free: `getProject()` always issues a fresh `saveProject()` and waits for the resulting `workspacesave`, and `handleWorkspaceSave` replaces project state rather than merging. The earlier cache + partial-text merge logic was defensive against `workspacesave` events with missing `text` keys, but live postMessage traces consistently show MakeCode emitting all `text` fields on every save. Round-tripping every read costs ~one postMessage hop per call and in exchange the editor's current state always reflects what the iframe actually has — including any edits a user might have made between turns.

`setProject` exists to make the *write* side reliable for the LLM tool loop:

1. **Preserve project header continuity.** The adapter tracks the last header it saw via `handleWorkspaceSave` and passes it back into `importProject` so MakeCode keeps the same project identity across `session_set_code` calls instead of treating each as a fresh project.
2. **Confirm decompile actually happened, not just that `switchBlocks` replied.** MakeCode replies `success:true` to the `switchblocks` postMessage even when it silently falls back to JS view because the TS can't be decompiled (it shows an in-iframe "Cannot convert to blocks" modal). Awaiting `switchBlocks()` alone is therefore not a reliable success signal. The adapter detects the failure by observing the workspacesave flow: a healthy decompile triggers at least one more `workspacesave` event after `switchBlocks` resolves, whereas a failed decompile emits no further postMessages at all — MakeCode logs TS error text to the iframe console only. `setProject` therefore races the next text-bearing `workspacesave` against a 5 s timer (`DECOMPILE_CONFIRM_TIMEOUT_MS`) and throws `"Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again."` on timeout. Empty `main.ts` imports skip the wait (the blank-project bootstrap doesn't trigger a follow-up save). If `switchBlocks` itself rejects with a decompile-shaped message (`/cannot convert to blocks|decompile|unsupported syntax|ts\d{4}/i`), it's rewrapped with the same hint; other rejections propagate unwrapped so transport hiccups don't get blamed on the model's code. The tool loop surfaces all of these as `isError: true` so the model self-corrects rather than calling `session_get_blocks_img` on uncompilable code.

### Tests are written first

Every new piece of production code lands with a failing test authored *before* the implementation. Red → green → refactor. Writing tests after the fact overfits them to whatever the code happens to do, masking wrong behaviour. Unit tests (Vitest) live under `packages/*/test/`; integration/e2e tests (Playwright) live under the same `test/` tree but run only via `npm run test:e2e`.

### Keep tests and docs in sync with the code

When a change alters observable behaviour or a documented contract, update the relevant tests and docs in the same commit. Concretely:
- If you change how a function/class behaves (new branch, new error path, new recovery, removed feature), update or add the corresponding unit test. If a test now passes for the wrong reason, fix the test rather than leaving it as-is.
- If you change something this file (`AGENTS.md`) describes — tool-loop recovery branches, flattening rules, system-prompt contract, executor interfaces, layering, logging namespaces — update the matching section. `AGENTS.md` is the working spec; stale entries here mislead future agents.
- If you change the system prompt, update `packages/app/test/system-prompt.test.ts` and any AGENTS.md guidance about what the prompt must/must not contain.
- If you change a public README example (root `README.md`, `packages/makecode-mcp/README.md`), make sure the example still runs.

Skip doc/test updates only for changes that are genuinely invisible from outside (renaming a local variable, comment cleanup, formatting). When in doubt, update.

### No shared state between chat and editor panels

The only connection between `ChatPanel` and `MakeCodePanel` in the app is the `IframeExecutor` instance passed as a prop. Do not introduce a global store, context, or event bus for this. Keep it a direct dependency.

### Verbose logging is part of the contract

This is a POC for teaching and research; a live trace of what the system is doing is how the developer (and student observers) debug it. Logging is enabled by default and must stay that way.

- Use the shared logger from `packages/makecode-mcp/src/shared/logger.ts`. Import via `makecode-mcp/browser` or `makecode-mcp/server` — never hand-roll `console.log` prefixes or instantiate a second logger.
- One namespace per module: `const log = createLogger("tool-loop")`. Pick a short, stable, hyphenated name. Existing namespaces include `app`, `adapter`, `tool-loop`, `webllm`, `panel`, `executor`, `mcp`, `tab-executor`, `puppeteer-tab-pool` — reuse these when extending the same area.
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

All MakeCode iframe integration — browser executor, server executor Puppeteer code, manual test pages — must use the `@microbit/makecode-embed` library (published as `@microbit/makecode-embed` on npm; source: https://github.com/microbit-foundation/makecode-embed). Never hand-roll the `postMessage` protocol. For non-React contexts use the `./vanilla` export (`MakeCodeFrameDriver`, `createMakeCodeRenderBlocks`); for React use `./react`. If a feature seems to require dropping to raw postMessage, check the library first — the answer is almost always there.

### React component

`MakeCodePanel` is a React component that wraps `@microbit/makecode-embed/react`. It must:
- Accept an `onExecutorReady(executor: BrowserExecutor) => void` callback prop (typed as the interface, not the concrete class)
- Accept an optional `onLoadError(reason: string) => void` callback. The panel starts a `LoadWatchdog` (`src/browser/load-watchdog.ts`) at mount that fires `onLoadError` once if neither `onEditorContentLoaded` nor `onWorkspaceLoaded` has fired within `MAKECODE_LOAD_TIMEOUT_MS` (30 s). The watchdog is cleared on first ready event and disposed on unmount.
- Expose nothing else about its internal iframe to the host app
- Handle iframe load/unload lifecycle cleanly, including calling `dispose()` on the adapter on unmount

The executor is bound to the panel's iframe for its lifetime. Editor state (the loaded code) lives in the iframe, so the same `IframeExecutor` instance across turns sees the same code — no session plumbing needed from the host app.

### Puppeteer browser pool

`BrowserPool` manages one persistent Puppeteer browser process for the lifetime of the MCP server. It must:
- Launch lazily on first use, not at import time
- Expose `openPage()`, `openWindow(url)`, and a `withTab<T>(fn: (page: PageLike) => Promise<T>): Promise<T>` method
- Always close the tab in a `finally` block regardless of errors
- Never close the browser process itself (it stays alive between requests)
- Handle browser crashes by relaunching on next use

`BrowserPool` is deliberately typed against a minimal `PageLike` (`close`/`goto`/`evaluate`/`url?`) and a `BrowserLauncher` callback so it can be unit-tested with doubles. Puppeteer is only wired in at `bin.ts`, in the `adaptPuppeteerBrowser` helper that wraps a real `puppeteer.Browser` into a `BrowserLike` (including the CDP-backed `openWindow` implementation).

`PuppeteerTabPool` consumes **two** `BrowserPool`s: a **render pool** (always headless, hosts the persistent stateless tab shared by `get_blocks_img_from_code` and `get_hex_file_from_code`) and a **session pool** (headless or headed per the `--headed` CLI flag / `MKCP_HEADED=1` env var, hosts one tab per `session_start`). In headed mode each session opens in its own OS window via CDP `Target.createTarget({ newWindow: true })`; the shell URL carries `session=<id>&label=<encoded>` query params so the shim sets `document.title` to a label Chromium uses as the OS window title.

### Server target layering

```
bin.ts (CLI)                                                ← parses --headed / MKCP_HEADED
  └── buildMcpServer({ executor })                          ← src/server/mcp-server.ts
        └── TabExecutor (implements ServerExecutor)         ← src/server/tab-executor.ts
              └── TabPool (interface)                       ← src/server/tab-pool.ts
                    └── PuppeteerTabPool                    ← src/server/puppeteer-tab-pool.ts
                          ├── renderPool: BrowserPool       ← src/server/browser-pool.ts (always headless)
                          ├── sessionPool: BrowserPool      ← src/server/browser-pool.ts (headless or headed)
                          ├── adaptPuppeteerBrowser()       ← src/server/puppeteer-browser-adapter.ts (CDP openWindow)
                          ├── PuppeteerDriver               ← src/server/puppeteer-driver.ts
                          └── startShellServer()            ← src/server/shell/shell-server.ts
```

`TabExecutor` (implements `ServerExecutor`) owns session lifecycle and delegates every per-session operation to a `MakeCodeDriver` exposed by a `TabHandle`. It generates the `session_id` itself and forwards `{ sessionId, label }` to `TabPool.openTab` so the pool can embed both into the shell URL. `TabPool` is the seam that makes `TabExecutor` unit-testable without Puppeteer. `PuppeteerTabPool` is the only concrete implementation today.

### MCP server shell

The MCP server serves a single static shell page to every Puppeteer tab from a local HTTP server started by `startShellServer()`:

- `src/server/shell/shell.html` — one `<iframe id="mk">` and a `<script type="module" src="/shim.js">`. Used for both session tabs and the shared stateless tab.
- `src/server/shell/shim.ts` — runs inside the shell page, wraps `MakeCodeFrameDriver` + `createMakeCodeRenderBlocks`, and exposes `window.__mkcp` (`ready`, `importProject`, `saveProject`, `compile`, `renderBlocksImage`). The shim eagerly starts adapter init on script load so the iframe begins fetching `makecode.microbit.org` immediately; `ready()` returns the same init promise so `PuppeteerTabPool.openTab` and `statelessPage()` can block until the editor's `onEditorContentLoaded` has fired. This matters on slow networks where MakeCode takes many seconds to load — without the await, the first tool call would itself trigger and wait on the load, but the MCP client meanwhile thinks the tool is ready. Each shim method returns a tagged `ShimResult<T>` (`{ ok: true, value } | { ok: false, error }`) so failures don't traverse `page.evaluate` as exceptions and pick up Puppeteer's browser-side stack frame — `PuppeteerDriver` unwraps the union on the Node side.
- `src/server/shell/shell-server.ts` — reads `shell.html` and bundles `shim.ts` with esbuild on first use (cached for the process lifetime), then serves them on `http://127.0.0.1:<ephemeral>`.

There is exactly one persistent **stateless tab** (`PuppeteerTabPool.statelessPage`) that hosts the same shell + editor as session tabs. `bin.ts` calls `PuppeteerTabPool.prewarm()` at MCP server startup so MakeCode begins loading immediately (don't await — failures are swallowed and the next `withStatelessTab` call retries). All `*_from_code` tools share this tab through `withStatelessTab(fn)`, which serialises calls via a promise-chain mutex so the editor's single-project state can't race. This buys editor-side TS-compile validation for `get_blocks_img_from_code` for free: it routes through the same `setProject` (importProject + switchBlocks + decompile-confirm-wait) that `session_set_code` uses, so TS that doesn't compile throws with the same actionable hint; valid TS that can't be decompiled to blocks passes and renders the grey "raw text" fallback. (The old `render.html` + `render-shim.ts` render-only path no longer exists — the unified editor tab replaces both it and the per-call transient tab that `get_hex_file_from_code` used to spin up.)

`PuppeteerDriver` implements `MakeCodeDriver` purely as `page.evaluate` calls against `window.__mkcp`. Do not add more IPC surface (e.g., `page.exposeFunction`) unless a tool genuinely cannot be expressed as a single evaluate call.

### MCP tool dispatch

`src/server/mcp-server.ts` uses the high-level `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and registers each tool with `server.registerTool(name, { description, inputSchema }, handler)`. The single source of truth is `serverToolMeta` in `shared/tools.ts` — Zod raw shapes + descriptions. `McpServer` consumes the shapes directly; `serverTools` (JSON Schema descriptors used by tests and the browser-shaped path) are derived from the same shapes via `z.toJSONSchema(z.strictObject(shape))` so the two views can never drift.

Each handler is wrapped in a `safe(name, fn)` helper that catches `SessionError` and arbitrary errors and returns `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error, code }) }] }`. Without this wrapper `McpServer` would surface a thrown error as a transport-level error, losing the session-code taxonomy (`missing` / `unknown`) that LLMs use to self-correct.

### CLI entrypoint

`bin.ts` (registered as the `makecode-mcp` bin) wires `PuppeteerTabPool` → `TabExecutor` → `buildMcpServer` → `StdioServerTransport`, and disposes the executor on SIGINT/SIGTERM. The server is a standard stdio MCP server — point Claude Desktop / MCP Inspector at `node dist/server/bin.js` (or `npx makecode-mcp` once installed).

Chrome is located at startup via `resolveChromePath` (`src/server/chrome-path.ts`), which prefers `PUPPETEER_EXECUTABLE_PATH` and otherwise calls `Launcher.getFirstInstallation()` from `chrome-launcher`. The executable path is passed to every `puppeteer.launch` call (both pools). Puppeteer's bundled Chromium download is intentionally skipped in the .mcpb staging install (`PUPPETEER_SKIP_DOWNLOAD=true`) so the extension bundle stays OS-agnostic — the user provides Chrome.

For local manual testing, run `npm run dev:test-mcp -w makecode-mcp`. This builds the package and launches the MCP Inspector (`npx @modelcontextprotocol/inspector`) wired to `node dist/server/bin.js`. See https://modelcontextprotocol.io/docs/tools/inspector for the Inspector UI.

### Claude Desktop extension (.mcpb)

`packages/makecode-mcp/manifest.json` + `scripts/build-mcpb.mjs` package the server as a Claude Desktop extension. The script stages `dist/`, `src/`, `manifest.json`, `README.md`, and a trimmed `package.json` into `.mcpb-staging/`, runs `npm install --omit=dev` there with `PUPPETEER_SKIP_DOWNLOAD=true`, then calls `npx @anthropic-ai/mcpb pack`. The resulting `dist/makecode-mcp.mcpb` is platform-agnostic because Chrome is discovered at runtime. The manifest exposes two `user_config` fields — `headed_mode` (boolean → `MKCP_HEADED` env var) and `chrome_path` (file → `PUPPETEER_EXECUTABLE_PATH`); the resolver treats empty `chrome_path` as "auto-detect", so the file picker can stay optional.

`src/` ships in the bundle on purpose: `shell-server.ts` reads `src/server/shell/shell.html` at runtime and esbuild-bundles `shim.ts` on first use, and the shim imports from `src/browser/` and `src/shared/`. Do not add `src/` to `.mcpbignore` without first pre-bundling that entry point at build time.

### Shared project defaults

Default MakeCode project files (`pxt.json` with `preferredEditor: "blocksprj"`, `main.blocks`, `README.md`) and the empty-editor error message live in `src/shared/project-defaults.ts` as `fillProjectDefaults(text, code)` and `EMPTY_EDITOR_ERROR`. Both executors and the server shim import from here — do not re-declare these constants in new code.

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
- **Stall-before-substantive-work recovery** — grammar-constrained `[]` is always a valid emission, and in practice Qwen sometimes emits it on turn 1 without calling any tool — describing the tool workflow inside a TypeScript code block instead. Before falling back to the plain-text branch, `runToolLoop` checks whether the history has any *substantive* call yet (`session_set_code`, `session_get_code`, `session_get_blocks_img`, `session_get_hex_file`, or the `_from_code` variants). If not, it appends a `STALL_REMINDER` system message and retries once with tools still enabled. Only if the stall persists does it fall back to plain text. The retry fires at most once per run (`stallRetried` flag). The cost is one extra inference on purely conversational queries that correctly emit `[]` — bounded and acceptable for the reliability gain on actionable queries.
- **Repeat-call recovery** — the smaller models sometimes ignore the system-prompt rule "never call the same tool twice" and lock into a single-tool loop (e.g. `session_get_code` every step). `runToolLoop` tracks every dispatched `(name + arguments)` in a `seenCalls` set; when a batch arrives where *every* call is a repeat, it skips dispatch and yields the plain-text follow-up instead of hammering the same tool until `maxSteps` trips. A mixed batch (some new, some repeats) still dispatches — interleaved reads are legitimate.

The plain-text follow-up itself is shared across all three exits (done-signal, repeat-call, stall fallback) via a local `plainTextFollowUp(label)` generator that streams from a tools-disabled completion.

### WebLLM history flattening

WebLLM's chat templates (e.g. Qwen2.5-Coder) reject `role: "tool"` and assistant messages carrying `tool_calls`, and additionally enforce that the last message be `user` or `tool` (`MessageOrderError`). This engine bypasses WebLLM's native tool-calling path and drives the model with a custom system prompt + JSON grammar, so the tool exchange only needs to be visible to the model as text.

`flattenToolHistory` in `webllm-engine.ts` collapses each assistant `tool_calls` message together with the immediately following `tool` results into a single assistant text message (the JSON the model itself emitted, plus `[result <name>] <content>` lines). This preserves the `user → assistant → user → assistant` alternation the model expects. An earlier attempt that emitted tool results as fresh `user` turns made the model treat every result as a new request and loop forever between `session_get_blocks_img` and `session_get_hex_file` until `maxSteps` tripped.

After collapsing, if the last message is `assistant`, a fixed `TOOL_CONTINUATION_PROMPT` is appended as a `user` message to satisfy WebLLM's last-message rule. The text nudges the model to stop calling tools and produce a plain-text explanation; it deliberately does **not** mention `[]` because spelling out `[]` in the prompt biased the model toward emitting empty arrays even when it should have called tools.

Image (`session_get_blocks_img*`, ~21KB base64) and hex (`session_get_hex_file*`, ~1.7MB base64) tool results are stubbed to a short summary in the flattened history. The model cannot use the bytes anyway, and feeding the hex back through WebLLM's tokenizer overflowed the JS stack with "Maximum call stack size exceeded".

The same flatten runs on the tools-disabled follow-up path — WebLLM's role rules apply regardless of whether `tools` was passed in.

Because the browser target has no sessions, the loop is stateless: no `session_id` injection, no next-step hint enrichment, no ordering of a setup call before siblings. If you add a new tool, just add a case to the `dispatchTool` switch.

Tool calls within a single batch are dispatched **sequentially** in the order the model emitted them. The smaller models in the picker frequently batch `session_get_code` + `session_set_code` + `session_get_blocks_img` in one turn intending strict ordering; running them in parallel races — a 17ms `session_get_blocks_img` returns before the ~2s `session_set_code` ingest commits, so blocks render against the pre-set state and throw `EMPTY_EDITOR_ERROR`. Inference cost dwarfs executor latency, so serialisation is essentially free. Do not reintroduce `Promise.all` here.

### System prompt

The system prompt must tell the LLM:
- It is a micro:bit coding assistant
- The MakeCode editor on the right is stateful across the conversation — code loaded via `session_set_code` persists for later calls like `session_get_blocks_img` and `session_get_hex_file`
- `session_set_code` followed by `session_get_blocks_img` is a valid multi-turn pattern (the PNG renders inline in the chat)
- `get_blocks_img_from_code` is self-contained — use it to preview a snippet without touching the editor
- Code should be valid MakeCode TypeScript (not standard Node.js TypeScript)

The browser prompt must not mention `session_start` / `session_end` / `session_id` — those belong to the server target and are irrelevant here.


## What Not To Do

- Do not add a backend server or API proxy. Everything must run from static files.
- Do not share executor state between multiple chat sessions. Each page load is a fresh session.
- Do not duplicate tool schema definitions. They live in `shared/tools.ts` only.
- Do not duplicate MakeCode project defaults. They live in `shared/project-defaults.ts` only.
