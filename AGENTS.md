# AGENTS.md

Working spec for AI agents on this repo. Sections map to subsystems — consult the relevant one before changing that area, and **update this file in the same commit when you change something it describes.** It captures the *why* (decisions, failed attempts, gotchas) that the source can't show on its own; keep it that way — don't add things that just restate the code.

This is a monorepo for **MakeCode MCP**: a TypeScript library + web app connecting an in-browser LLM chat to a MakeCode micro:bit editor.

- **`packages/makecode-mcp`** — core library, owns all MakeCode integration. Two build targets: `browser` (React + postMessage) and `server` (Node + Puppeteer + MCP protocol).
- **`packages/app`** — React + Vite app. Single-chat = split-pane (WebLLM chat left, MakeCode iframe right). Comparison mode = three panels side-by-side for evaluating models.

Setup, scripts, and package overviews live in `README.md` and `packages/makecode-mcp/README.md`. Package manager is **npm workspaces** — not pnpm/yarn. Run `npm run build` before running the app if you changed `makecode-mcp` (TypeScript project references).

`makecode-mcp/tsconfig.json` sets `tsBuildInfoFile: "./dist/.tsbuildinfo"` deliberately: the incremental-build sidecar lives inside `dist/` so `rm -rf dist` wipes it and forces a full rebuild. Default-location buildinfo would survive a `dist` wipe and make tsc skip emission.

## Cross-cutting rules

### Tests first, docs in sync
Every new piece of production code lands with a test authored *before* the implementation (red → green → refactor) — tests written after the fact overfit to whatever the code does. Unit tests (Vitest) live in `packages/*/test/`; e2e (Playwright, `npm run test:e2e`) live in the same tree.

When a change alters observable behaviour or a documented contract, update the matching tests *and* this file in the same commit. A test that now passes for the wrong reason gets fixed, not left. Changing the system prompt → update `packages/app/test/system-prompt.test.ts`. Skip doc/test updates only for genuinely invisible changes (local rename, comment cleanup). If you find yourself silencing a log to pass a test, fix the test — the logger is already test-silent.

### Verbose logging is part of the contract
This is a teaching/research POC; a live trace is how the developer and student observers debug it. Logging is on by default and must stay that way.

- Use the shared logger (`packages/makecode-mcp/src/shared/logger.ts`), imported via `makecode-mcp/browser` or `makecode-mcp/server`. Never hand-roll `console.log` prefixes or a second logger.
- One namespace per module: `const log = createLogger("tool-loop")`. Existing: `app`, `adapter`, `tool-loop`, `webllm` (shared by `webllm-engine.ts` + `webllm-slot.ts`), `comparison`, `panel`, `executor`, `mcp`, `tab-executor`, `puppeteer-tab-pool`, `browser-pool`. Reuse these when extending the same area.
- Log lifecycle events a reader needs to follow the flow: run entry/exit, each tool-loop step with `finish_reason` + pending-call count, each tool dispatch with args summary + result size, stall detection/recovery, errors.
- `preview(value, maxChars?)` for anything large (code, PNG/hex base64, JSON). `log.time(label)` for async boundaries that might hang. `log.group`/`log.groupEnd` paired in `try/finally` to bracket a unit of work.
- **Server code (`packages/makecode-mcp/src/server/`) must not write to stdout** — the MCP stdio transport owns it. The shared logger routes Node output to stderr.
- Disable paths (keep these): `localStorage.setItem('mkcp:log','0')` or `?mkcp-log=0` (browser); `MKCP_LOG=0` (Node); auto-off under `VITEST` / `NODE_ENV=test`.

### No shared state between chat and editor panels
The only link between a chat surface and its `MakeCodePanel` is the `IframeExecutor` instance passed as a prop. No global store, context, or event bus. Comparison mode keeps per-panel `executorRefs[i]` in `ComparisonLayout`, exposed to each adapter via a `getExecutor()` closure (no cross-panel store). The only thing comparison panels share is the active completion via `slotCompletionRef` — a controlled read of the single `useWebLLMSlot`.

### Two executors, two interfaces — the iframe *is* the session on browser
Interfaces in `src/shared/types.ts`, matched to how each target is used:

- **`BrowserExecutor`** (4 methods, no `session_id`) — one iframe per instance; the iframe *is* the session (editor state persists for the instance lifetime). Tool calls are stateless from the LLM's view — no `session_start`/`session_end` ceremony.
- **`ServerExecutor`** (8 methods, stateful ones take `session_id`) — one MCP process serves many clients, each holding an opaque `session_id` mapping to a dedicated Puppeteer tab. `session_start` opens a tab, `session_end` closes it.

Schemas in `src/shared/tools.ts` split into `browserTools` (4) and `serverTools` (8) — deliberately asymmetric. Keep descriptions consistent where behaviour matches; let them diverge where targets differ. If a new tool fits both, implement it on both.

### Tool availability — both hex tools are server-only
Browser exposes editor-state tools (`session_get_code`, `session_set_code`, `session_get_blocks_img`) + stateless `get_blocks_img_from_code`.

- `get_hex_file_from_code` is browser-omitted: `makecode-embed` has a blocks renderer but no stateless compile path; faking one needs a hidden editor or mutating the main one — both break the pure-function contract.
- `session_get_hex_file` is browser-omitted: the MakeCode iframe sits right next to the chat, so the user already has MakeCode's Download button (+ WebUSB flash). A tool producing an opaque 1.7 MB base64 blob the LLM can't read, when a one-click download exists immediately to the right, is strictly worse and invites speculative calls.

`BrowserExecutor` simply doesn't declare `getHexFile` (vs. a tool that always throws). On the server target both hex tools stay useful and gated by `session_start`/`session_end`. `_from_code` variants are session-less on both targets and must be **pure** — no persistent editor reads/writes, same input → same output.

### `session_get_blocks_img` requires loaded code
In the browser executor, `getBlocksImage()` must check the editor isn't empty and otherwise throw this exact LLM-facing message (part of the interaction loop — not a generic error):
```
No code loaded in the editor. Call session_set_code first to load code before requesting session_get_blocks_img.
```

## Package: `makecode-mcp`

### Entry points & library use
Exports `./browser` and `./server` only. Never cross-import (`makecode-mcp/server` in browser code or vice versa) — be explicit.

**All** MakeCode iframe integration must go through `@microbit/makecode-embed` (npm; source: https://github.com/microbit-foundation/makecode-embed) — never hand-roll `postMessage`. Vanilla contexts use `./vanilla` (`MakeCodeFrameDriver`, `createMakeCodeRenderBlocks`); React uses `./react`. If a feature seems to need raw postMessage, check the library first — the answer is almost always there.

### `MakeCodePanel` (React)
Wraps `@microbit/makecode-embed/react`. Must: accept `onExecutorReady(executor: BrowserExecutor)` (typed as the interface, not the class); accept optional `onLoadError(reason)`; expose nothing else about its iframe; dispose the adapter on unmount. The `LoadWatchdog` (`src/browser/load-watchdog.ts`) starts at mount and fires `onLoadError` once if neither `onEditorContentLoaded` nor `onWorkspaceLoaded` fires within `MAKECODE_LOAD_TIMEOUT_MS` (30 s); cleared on first ready event. The executor is bound to the panel's iframe for its lifetime, so the same instance across turns sees the same code — no session plumbing from the host.

### Adapter is cache-free; `setProject` confirms decompile
`MakeCodeFrameDriverAdapter` is intentionally cache-free: `getProject()` always issues a fresh `saveProject()` and waits for the resulting `workspacesave`; `handleWorkspaceSave` replaces project state rather than merging. (The old cache + partial-text-merge guarded against `workspacesave` events with missing `text` keys, but live traces show MakeCode always emits all `text` fields.) Round-tripping every read costs ~one postMessage hop and guarantees the editor's current state — including mid-turn user edits — is what reads return.

`setProject` makes the *write* side reliable for the tool loop:
1. **Header continuity** — the adapter tracks the last header from `handleWorkspaceSave` and passes it back into `importProject` so MakeCode keeps the same project identity across `session_set_code` calls.
2. **Confirm decompile, not just `switchBlocks` reply** — MakeCode replies `success:true` to `switchblocks` even when it silently falls back to JS view (TS can't decompile; shows an in-iframe modal, logs to console only). A healthy decompile emits ≥1 further `workspacesave`; a failed one emits nothing. So `setProject` races the next text-bearing `workspacesave` against `DECOMPILE_CONFIRM_TIMEOUT_MS` (5 s) and on timeout throws `"Code was loaded into the editor but failed to compile to blocks. Fix the TypeScript and call session_set_code again."` Empty `main.ts` imports skip the wait (blank bootstrap emits no follow-up save). If `switchBlocks` itself rejects with a decompile-shaped message (`/cannot convert to blocks|decompile|unsupported syntax|ts\d{4}/i`) it's rewrapped with the same hint; other rejections propagate unwrapped so transport hiccups aren't blamed on the model. The tool loop surfaces all as `isError: true` so the model self-corrects.

### Puppeteer browser pool
`BrowserPool` manages one persistent browser process for the server's lifetime: launches lazily on first use, exposes `openPage()` / `openWindow(url)` / `withTab(fn)` (always closing the tab in `finally`), never closes the browser itself, relaunches after a crash. It's typed against a minimal `PageLike` + `BrowserLauncher` callback so it's unit-testable with doubles; real Puppeteer is wired only at `bin.ts` via `adaptPuppeteerBrowser`. An `onDisconnected` listener (identity-guarded so a late disconnect can't null a replacement) evicts a crashed/killed browser immediately instead of waiting for the next `isConnected()` check.

`PuppeteerTabPool` consumes **two** pools: a **render pool** (always headless, hosts the persistent stateless tab shared by both `*_from_code` tools) and a **session pool** (headless or headed per `--headed` / `MKCP_HEADED=1`, one tab per `session_start`). Headed sessions each open in their own OS window via CDP `Target.createTarget({ newWindow: true })`; the shell URL carries `session=<id>&label=<encoded>` so the shim sets `document.title` (Chromium uses it as the window title).

### Server layering
```
bin.ts (CLI, parses --headed / MKCP_HEADED)
  └── buildMcpServer({ executor })            ← src/server/mcp-server.ts
        └── TabExecutor (ServerExecutor)      ← src/server/tab-executor.ts
              └── TabPool (interface)         ← src/server/tab-pool.ts
                    └── PuppeteerTabPool       ← src/server/puppeteer-tab-pool.ts
                          ├── renderPool / sessionPool: BrowserPool
                          ├── adaptPuppeteerBrowser() (CDP openWindow)
                          ├── PuppeteerDriver  ← src/server/puppeteer-driver.ts
                          └── startShellServer() ← serves dist/shell/{shim.js, shell.html}
```
`TabExecutor` owns session lifecycle, generates the `session_id`, forwards `{ sessionId, label }` to `TabPool.openTab`, and delegates per-session ops to a `MakeCodeDriver` from a `TabHandle`. `TabPool` is the seam that keeps `TabExecutor` testable without Puppeteer (`PuppeteerTabPool` is the only impl). It also runs an **idle-session reaper** (default 30 min timeout, 1 min interval): each successful per-session call refreshes `lastUsedAt`; the reaper closes stale sessions and remembers up to 256 recent expirations so reuse raises `SessionError("expired")` (precise) rather than `"unknown"`. Override via `new TabExecutor(pool, { idleTimeoutMs, reapIntervalMs, now })`; `idleTimeoutMs: 0` disables it.

`PuppeteerDriver` implements `MakeCodeDriver` purely as `page.evaluate` calls against `window.__mkcp`. Don't add more IPC surface (e.g. `page.exposeFunction`) unless a tool genuinely can't be one evaluate call.

### Shell (browser-side, prebuilt — not shipped as TS)
Sources under `src/shell/`, bundled at build time by `scripts/build-shim.mjs` (esbuild → `dist/shell/shim.js`, copies `shell.html` + `blocks-viewer.html`; runs after `tsc -b`).

- `shell.html` — one `<iframe id="mk">` + `<script type="module" src="/shim.js">`. Used for session tabs and the stateless tab.
- `shim.ts` — runs in the shell page, wraps `MakeCodeFrameDriver` + `createMakeCodeRenderBlocks`, exposes `window.__mkcp` (`ready`, `importProject`, `saveProject`, `compile`, `renderBlocksImage`). It **eagerly** starts adapter init on script load so the iframe begins fetching `makecode.microbit.org` immediately; `ready()` returns that same init promise so `openTab`/`statelessPage` can block until `onEditorContentLoaded`. (Without the eager await, the first tool call would silently trigger and wait on the load while the MCP client already thinks the tool is ready — bad on slow networks.) Each method returns a tagged `ShimResult<T>` (`{ok:true,value} | {ok:false,error}`) so failures don't traverse `page.evaluate` as exceptions picking up a browser-side stack; `PuppeteerDriver` unwraps on the Node side.
- `blocks-viewer.html` — the MCP Apps (SEP-1865) widget, served via MCP **`resources/read`, not HTTP**. Lets Apps-aware hosts (Claude Desktop) render the blocks PNG **inline in the assistant message** instead of inside the collapsed tool-use accordion. Self-contained page that listens for the host postMessage envelope and shape-walks the payload for an `{type:"image", data, mimeType:"image/*"}` block (shape-walk tolerates envelope differences across Claude Desktop / Claude.ai / VS Code). The base64 `image` block is **never removed** — it stays the canonical result + fallback for non-Apps hosts (LM Studio, Inspector) and the model's vision context. `mcp-server.ts` reads it once at init (fail-fast) and serves it at `ui://makecode-mcp/blocks-viewer.html`; the two image tools advertise that URI via `_meta.ui.resourceUri`.
- `shell-server.ts` (Node) reads prebuilt `dist/shell/{shim.js, shell.html}` at startup and serves them on an ephemeral `127.0.0.1` port; throws on startup if they're missing rather than 404'ing every call. It does **not** serve `blocks-viewer.html` (that's MCP `resources/read`).

There is exactly one persistent **stateless tab** (`PuppeteerTabPool.statelessPage`) hosting the same shell+editor. `bin.ts` calls `prewarm()` at startup (don't await — failures are swallowed, next call retries). All `*_from_code` tools share it via `withStatelessTab(fn)`, serialised by a promise-chain mutex so the single-project state can't race. This buys editor-side TS-compile validation for `get_blocks_img_from_code` free — it routes through the same `setProject` as `session_set_code`, so uncompilable TS throws the same hint; valid-but-undecompilable TS renders the grey raw-text fallback. (The old `render.html` + per-call transient tab paths no longer exist — the unified editor tab replaces both.)

### MCP tool dispatch
`mcp-server.ts` uses the high-level `McpServer` and registers each tool via a local `reg(name, {description, inputSchema, _meta?}, handler)`. Single source of truth is `serverToolMeta` in `shared/tools.ts` (Zod raw shapes + descriptions); `McpServer` consumes the shapes directly, and `serverTools` (JSON Schema for tests / browser-shaped path) is derived from the same shapes via `z.toJSONSchema(z.strictObject(shape))` — they can't drift.

`reg`'s optional `meta` arg is forwarded as `_meta`. Only the two image tools use it today (`{ ui: { resourceUri: "ui://makecode-mcp/blocks-viewer.html" } }`); the module also `registerResource(...)`s the widget once and declares the `resources` capability. The widget is **additive** — the `image` content block (from `blocksImageMcpContent`) is still emitted so non-Apps hosts keep working.

Each handler is wrapped in `safe(name, fn)`, which catches `SessionError` + arbitrary errors and returns `{ isError: true, content: [{type:"text", text: JSON.stringify({error, code})}] }`. Without it, `McpServer` would surface a throw as a transport-level error, losing the `missing`/`unknown`/`expired` taxonomy LLMs self-correct on. (`expired` = idle reaper closed the session; model treats it like `unknown` — start a new one.)

### CLI, Chrome, .mcpb packaging
`bin.ts` (the `makecode-mcp` bin) wires `PuppeteerTabPool → TabExecutor → buildMcpServer → StdioServerTransport` and disposes on SIGINT/SIGTERM. It's a standard stdio MCP server — point hosts at `node dist/server/bin.js`. Local manual testing: `npm run dev:test-mcp -w makecode-mcp` (builds + launches MCP Inspector).

Chrome is located at startup by `resolveChromePath` (`src/server/chrome-path.ts`): prefers `PUPPETEER_EXECUTABLE_PATH`, else `Launcher.getFirstInstallation()` from `chrome-launcher`; the path is passed to every `puppeteer.launch`. The bundled Chromium download is skipped in the .mcpb install (`PUPPETEER_SKIP_DOWNLOAD=true`) so the bundle stays OS-agnostic — the user supplies Chrome.

`manifest.json` + `scripts/build-mcpb.mjs` package the server as a Claude Desktop extension: build, stage `dist/` + `manifest.json` + `README.md` + a trimmed `package.json` into `.mcpb-staging/`, `npm install --omit=dev` (skip-download), `mcpb pack` → `dist/makecode-mcp.mcpb`. Manifest `user_config`: `headed_mode` (→ `MKCP_HEADED`) and `chrome_path` (→ `PUPPETEER_EXECUTABLE_PATH`; empty = auto-detect, so the picker stays optional). **`src/` is not in the bundle** (`.mcpbignore`) — everything browser-side is prebuilt into `dist/shell/`, and `esbuild` is a devDependency. If you ever need raw TS at runtime, pre-bundle a new entry at build time rather than restoring `stage("src")`.

### Shared modules — don't re-declare
- **`shared/project-defaults.ts`** — default project files (`pxt.json` with `preferredEditor: "blocksprj"`, `main.blocks`, `README.md`) + `EMPTY_EDITOR_ERROR`, via `fillProjectDefaults(text, code)`. Both executors and the shim import from here.
- **`shared/tool-results.ts`** — result codecs: `encodeBlocksImage`/`encodeHex` (tool-loop), `blocksImageMcpContent`/`hexFileMcpPayload` (MCP wrapper), `stubImageResult`/`stubHexResult` (history flatten + meter), `decodeBlocksImage` (adapter). Never rebuild these shapes inline.

## Package: `app`

### Configuration (`config.ts`)
Single file for content edited without touching components/engine — stays data-only:
- **`MODELS`** — user-selectable models (`{ id, shortLabel, label }`); engine + UI pick up new entries automatically. Context-window size is resolved at load time from `prebuiltAppConfig` — don't add it here.
- **`DEFAULT_MODEL_ID`** (one of `MODELS[].id`), **`PREFAB_PROMPTS`** (comparison opener suggestions), **`SYSTEM_PROMPT`**.

Everything else imports these from `config.ts`. `ModelId` is the derived union of ids. Changing `SYSTEM_PROMPT` → update `system-prompt.test.ts`.

### WebLLM tool-calling (engine)
All models (Qwen2.5-Coder 7B default, Hermes-3 8B, Qwen3 8B, Llama-3.1 8B) share one path in `webllm-engine.ts`: inject a tools system prompt, grammar-constrain output via `response_format` to a JSON array of `{name, arguments}`, parse the stream into synthetic `tool_calls` deltas. Add models by appending to `MODELS` — no engine changes.

WebLLM's native Hermes-2-Pro path is **deliberately bypassed**: its injected prompt omits the `<tool_call></tool_call>` wrapper Hermes-3 was trained on, so Hermes-3 emits bare JSON/markdown that WebLLM's parser then rejects. Owning prompt + parser end-to-end gives reliable behaviour across the whole picker.

### Load lifecycle (`useWebLLMSlot`)
`useWebLLMSlot({ onLoaded? })` (`webllm-slot.ts`) returns `{ completion, completionRef, loadState, loadedModelId, load, cancel }`. `completion` is the render snapshot; **`completionRef` is updated immediately on load, before React re-renders** — use it in closures that run right after `load()` resolves. It internalises: the `LoadHandle` cancel-via-mismatch pattern (a superseded load's progress/result are dropped so the active load owns UI state); the `LoadCancelledError` branch (user cancel → `idle`, not `error`); and **GPU buffer freeing on switch** — `load(B)` calls `cancel()` on any prior handle first (`engine.unload()`), without which switching would leak the prior model's buffers until the next reload.

Both `App.tsx` and `ComparisonLayout` consume it, but only `App.tsx` passes `onLoaded`. The hook does **not** bump the chat epoch itself — callers decide. Single-chat: changing models **resets the chat** — `ChatThread` owns its `useLocalRuntime` and is keyed on a `chatEpoch` that bumps on `onLoaded`, so it remounts empty. `MakeCodePanel` lives above that boundary, so the iframe + loaded code persist across switches.

Requires WebGPU (Chrome 113+). Show clear load progress on first load (~4–5 GB, cached in the Cache API after). If WebGPU is missing, show a clear error — don't silently fall back to CPU without warning.

The picker dropdown shows `shortLabel`; the full `label` shows in the loading overlay. A **Load model** button triggers the download; while loading it's disabled and the composer is disabled with a "Load a model to begin" notice. On finish it becomes a "model loaded" pill; changing the dropdown flips it back to the button.

### Tool-call loop (`tool-loop.ts`)
The model may return `finish_reason: "tool_calls"` repeatedly before final text. Loop: send with tools → if `tool_calls`, dispatch all calls **sequentially in emission order** → append the assistant tool-call message + all result messages → re-send → repeat until `stop` → stream final text. Never truncate/drop tool-call messages mid-loop. If you add a tool, just add a `dispatchTool` case — the browser loop is stateless (no `session_id` injection, no hint enrichment, no sibling ordering).

**Sequential, not `Promise.all`:** small models batch `session_get_code` + `session_set_code` + `session_get_blocks_img` in one turn intending order; parallel races — a ~17 ms `session_get_blocks_img` returns before the ~2 s `session_set_code` commits and renders against the pre-set state, throwing `EMPTY_EDITOR_ERROR`. Inference cost dwarfs executor latency, so serialising is free. **Don't reintroduce `Promise.all`.**

Three recovery branches share a `plainTextFollowUp(label)` generator (streams from a tools-disabled completion):
- **Empty `tool_calls` done-signal** — `finish_reason === "tool_calls"` but the model emitted `[]` → one follow-up call with `tools: []` for a plain-text reply, then return. Never recurses.
- **Stall before substantive work** — Qwen sometimes emits `[]` on turn 1, describing the workflow in a TS code block instead. Before falling back to plain text, check whether history has any *substantive* call yet (`session_set_code`/`session_get_code`/`session_get_blocks_img`/`get_blocks_img_from_code`); if not, append a `STALL_REMINDER` system message and retry once with tools still on (`stallRetried` flag, at most once per run). Costs one extra inference on purely conversational queries — acceptable.
- **Repeat-call** — small models sometimes lock into one tool (e.g. `session_get_code` every step). `seenCalls` tracks every dispatched `(name+arguments)`; when *every* call in a batch is a repeat, skip dispatch and yield the plain-text follow-up. A mixed batch still dispatches (interleaved reads are legitimate).

### History flattening
WebLLM's chat templates reject `role:"tool"` and assistant messages with `tool_calls`, and require the last message be `user`/`tool` (`MessageOrderError`). Since we drive the model with our own prompt + grammar, the tool exchange only needs to be visible as text.

`flattenToolHistory` collapses each assistant `tool_calls` message + the following `tool` results into **one** assistant text message (JSON reconstruction + `[result <name>] <content>` lines), preserving `user → assistant → user → assistant`. **Failed attempts (don't repeat):** emitting results as fresh `user` turns made the model treat each result as a new request and loop forever; keeping the assistant message empty + results in a separate `user` message (chasing KV-cache reuse) confused Qwen on turn 1, stalled it to plain-text, and produced prose where tool calls belonged. **Do not split results out of the assistant message.**

After collapsing, if the last message is `assistant`, a fixed `TOOL_CONTINUATION_PROMPT` is appended as `user` to satisfy the last-message rule. It nudges toward plain text but **deliberately doesn't mention `[]`** — spelling it out biased the model toward empty arrays even when it should call tools.

Image results (`session_get_blocks_img*`, ~21 KB base64) are stubbed to a summary — the model can't use the bytes. Hex results are stubbed defensively too (`HEX_TOOL_NAMES`), even though the browser exposes no hex tool, because a ~1.7 MB base64 hex once overflowed the JS stack ("Maximum call stack size exceeded"). The same flatten runs on the tools-disabled follow-up — role rules apply regardless.

Because the collapse reconstructs JSON (different whitespace/key order from the raw emission), WebLLM's `compareConversationObject` cache check always misses and every loop step full-reprefills — which is why the context meter estimates from chars, not reported `prompt_tokens`.

### System prompt (browser)
Must tell the LLM: it's a micro:bit coding assistant; the MakeCode editor on the right is stateful (code from `session_set_code` persists for later `session_get_blocks_img`); `session_set_code` → `session_get_blocks_img` is a valid multi-turn pattern (PNG renders inline); `get_blocks_img_from_code` is self-contained for previews without touching the editor; there is no hex tool — for flash/download/.hex, point to MakeCode's Download button (which also does WebUSB flashing); code is MakeCode TypeScript (not Node.js TS).

Must **not** mention `session_start`/`session_end`/`session_id` (server-only) or advertise `session_get_hex_file`/`get_hex_file_from_code` (not on browser).

### Context-window meter
Send button wrapped in an SVG ring (`chat/context-meter.ts` + `chat/ContextRing.tsx`). Non-obvious bits:
- **Pure char estimate** — always `estimateUsedTokens({ messages, composerText, systemPrompt, staticOverheadChars })`. Reported `prompt_tokens` is logged (adapter `perf`) but not used as a baseline: with no cache reuse it's a full reprefill each step, so summing overcounts and last-only loses history.
- **Context size** from `prebuiltAppConfig`, resolved by `resolveContextWindow` in `webllm-engine.ts`. Don't hardcode in `MODELS`.
- **The estimate must match what the model receives** — image/hex results count as the same `stubImageResult`/`stubHexResult` the flatten substitutes; the tools prompt from `buildToolsSystemPrompt` is `staticOverheadChars` (`TOOLS_PROMPT_CHARS` in `ContextRing.tsx`). Change the flatten or tools prompt → update the meter.
- **Palette is fixed across accents** — `--ctx-ring-{ok,warn,full,track,streaming}` don't swap with `--accent` (magenta accent + magenta "full" would blend).
- **Button geometry single-sourced in CSS** (`--composer-btn-size`, `--composer-btn-radius`, `--context-ring-outset`); the mirrored constants in `ContextRing.tsx` (parametric SVG path) must bump together.

### Comparison mode
Toggled via `comparisonMode` in `ChatSettings`. Purpose: judge which small model needs the least hand-holding to reach a working program — at 7–8B q4f16, variance is high, so the metric is hand-holding, not same-input parity.

**Topology** (`comparison/ComparisonLayout.tsx`, `PANEL_INDICES = [0,1,2]`):
- Three `ChatPanelView`, each with its own `useLocalRuntime` + adapter; threads persist across switches.
- Three `MakeCodePanel` iframes mounted at once; only the active is visible (`opacity:0; pointer-events:none` on others). **Never `display:none`** — it reloads the iframe and loses editor state.
- Exactly **one** `useWebLLMSlot`, serving the active panel. Switching = `unload()` + `reload(otherId)` (~3–5 s from disk cache). Only the active model is in GPU. Don't add a `slots[]` array — single-slot + reload is intentional (the unified-memory swap cost is acceptable).
- All adapters read the active completion via `slotCompletionRef` (`slot.completionRef`). Inactive panels can't run inference — their composer is a "Switch to this model" button.
- `App.tsx` branches on `comparisonMode`; the single-chat JSX is an **inlined `singleChatLayout` const, not a nested component** — a nested function is a fresh type each render and would remount `MakeCodePanel`, flashing the editor on every state change.

**`Thread.composerSlot`** — optional `ReactNode` replacing the default `<Composer />`. `ChatPanelView` uses it for inactive panels (the switch button) and `hideComposer` (passes `null`). The switch button must be `position:absolute; bottom:0` like `.composer` (`.thread-viewport` is `height:100%`, so a static footer renders below it, invisible).

**Switching** — switch button → `switchActive(index)` (sets `activePanelIndex` synchronously, awaits `slot.load`). Dropdown on the *active* panel → `switchActive(panelIndex, newModelId)` directly (avoids a stale `selectedModelIds` read). Dropdown on an *inactive* panel → updates that slot's id only, no load. Mid-switch re-entry is safe (`slot.load()` always cancels the prior handle).

**Settings** — shared single instance. In comparison mode `App.tsx` renders a floating `.comparison-settings-btn` and passes `<SettingsPanel>` as a `settingsOverlay` prop; the overlay anchors to `.comparison-chats` (relative) so it covers only the chat columns. A `useEffect` closes settings when `comparisonMode` becomes true.

**Shared opener (broadcast)** — when `showOpenerBar` (`allThreadsEmpty && !broadcastPending`), a `.comparison-opener-bar` spans all panels with a `PREFAB_PROMPTS` dropdown + shared input; all panels get `hideComposer` so the bar is the only input. "Send to all" sets `broadcastPending=true` (hides the bar first), then fans out **sequentially**: for each `i`, set `activePanelIndex=i`, `await slot.load(...)`, append the user message to panel `i` and await its turn via `runtime.thread.unstable_on("runEnd", …)`. After the loop `broadcastPending` resets but `allThreadsEmpty` is now false so the bar stays gone. `allThreadsEmpty` derives from `threadHasMessages` state, updated via per-panel `onHasMessages`. No cancel button (~30–60 s total; refresh to abort, or click another panel's switch to cancel implicitly).

**Reset / out of scope** — mode toggle is the reset (state is fresh on every entry/page load; no localStorage). Do **not** add: per-panel temperature/prompt/sampling overrides, per-panel reset buttons, localStorage persistence, background prewarm of inactive models, three concurrent engines, or automated metrics.

## What Not To Do
- No backend server or API proxy — everything runs from static files.
- No shared executor state across chat sessions — each page load is fresh.
- Don't duplicate tool schemas (`shared/tools.ts`) or project defaults (`shared/project-defaults.ts`).
- Don't `display:none` an inactive comparison iframe — use `opacity:0; pointer-events:none`.
- Don't nest `singleChatLayout` as a function component — keep it inlined JSX.
- Don't run three concurrent `WebLLMSlot`s — single-slot + reload-on-switch is intentional.
- Don't reintroduce `Promise.all` for tool-call batches — sequential emission order is intentional.
