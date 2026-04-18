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
```

Package manager: **npm workspaces**. Do not use pnpm or yarn.

TypeScript project references are used across packages. Run `npm run build --workspaces` before running the app if you've changed `makecode-mcp`.


## Key Architectural Rules

### Two executors, one interface

Both browser executor (via iframe) and server executor (via puppeteer tab) implement the same `MakeCodeExecutor` interface from `src/shared/types.ts`. If you add a new tool, implement it in both executors.

### Tool availability

All tools are available on both targets **except `get_hex_file_from_code`**, which is server-only. The `makecode-embed` library exposes a blocks renderer (`createMakeCodeRenderBlocks`) but no equivalent stateless compile path; implementing one in the browser would require a hidden editor iframe or mutating the main editor — both violate the pure-function contract. On the browser target, `get_hex_file_from_code` throws a descriptive error directing callers to use `set_code` + `get_hex_file` instead. Stateful tools require an active session opened by `start_session` and closed by `end_session`. The `_from_code` variants are session-less.

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
- Accept an `onExecutorReady(executor: MakeCodeExecutor) => void` callback prop (typed as the interface, not the concrete class)
- Expose nothing else about its internal iframe to the host app
- Handle iframe load/unload lifecycle cleanly, including calling `dispose()` on the adapter on unmount

### Puppeteer browser pool

`BrowserPool` manages one persistent Puppeteer browser process for the lifetime of the MCP server. It must:
- Launch lazily on first use, not at import time
- Expose a `withTab<T>(fn: (page: Page) => Promise<T>): Promise<T>` method
- Always close the tab in a `finally` block regardless of errors
- Never close the browser process itself (it stays alive between requests)
- Handle browser crashes by relaunching on next use

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

The loop also handles two Qwen-specific quirks:
- **Empty `tool_calls` as done-signal** — when `finish_reason === "tool_calls"` but no calls were produced (the schema-constrained model emitted `[]`), the loop makes one follow-up call with `tools: []` to let the model stream a plain-text reply, then returns. This never recurses.
- **Session-id injection** — some models batch `start_session` with a stateful call in the same turn, or emit a `"$SESSION_ID"` placeholder before the real id is known. `runToolLoop` runs `start_session` first when it appears in a batch, captures the returned `session_id` into `knownSessionId`, and substitutes it into any sibling call whose `session_id` is missing or a `$`-prefixed placeholder before dispatching. Order of results is preserved.

### System prompt

The system prompt must tell the LLM:
- It is a micro:bit coding assistant
- The MakeCode editor is open on the right and maintains state across the conversation while a session is open
- Call `start_session` before using stateful tools; call `end_session` when done
- `set_code` followed by `get_blocks_svg` is a valid multi-turn pattern
- `get_blocks_svg_from_code` and `get_hex_file_from_code` are self-contained and do not affect the editor
- Code should be valid MakeCode TypeScript (not standard Node.js TypeScript)


## What Not To Do

- Do not add a backend server or API proxy. Everything must run from static files.
- Do not share executor state between multiple chat sessions. Each page load is a fresh session.
- Do not duplicate tool schema definitions. They live in `shared/tools.ts` only.
