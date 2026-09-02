# makecode-mcp

A TypeScript library that exposes the [MakeCode micro:bit editor](https://makecode.microbit.org/) to LLMs through a small tool surface. Ships two targets from a single codebase:

- **`makecode-mcp/browser`**: A React `MakeCodePanel` component and a stateless `IframeExecutor` for driving an embedded MakeCode iframe from an in-browser LLM.
- **`makecode-mcp/server`**: A Node.js binary (`makecode-mcp`) that runs as a stdio [Model Context Protocol](https://modelcontextprotocol.io) server, using Puppeteer to host a MakeCode editor tab that every LLM session shares.

All MakeCode integration goes through [`@microbit/makecode-embed`](https://github.com/microbit-foundation/makecode-embed) — no hand-rolled `postMessage`.

## Install

This package is private to the monorepo and consumed via npm workspaces. From the repo root:

```bash
npm install
npm run build -w makecode-mcp
```

## Two targets, two interfaces

The browser and server targets have different shapes, each matched to how it's used:

| | **`BrowserExecutor`** | **`ServerExecutor`** |
|---|---|---|
| Session model | One executor = one iframe = one session. The iframe *is* the session. | One process serves many clients; each holds an opaque `session_id` naming a project kept in the server's memory. |
| Tools exposed | 5 (no `session_id`) | 8 (stateful tools take `session_id`, plus `session_start` / `session_end`) |
| Import | `import { IframeExecutor, MakeCodePanel } from "makecode-mcp/browser"` | `import { buildMcpServer, SessionExecutor } from "makecode-mcp/server"` |

Never import from `makecode-mcp/server` in browser code and vice versa.

### Shared tools

Both targets expose the same core operations. Descriptions live in [src/shared/tools.ts](src/shared/tools.ts).

| Tool | Browser | Server | Returns |
|---|---|---|---|
| `session_start` | — | ✓ | `{ session_id }` |
| `session_end` | — | ✓ | void |
| `session_get_code` | ✓ | ✓ | TypeScript source |
| `session_set_code` | ✓ | ✓ | void |
| `session_get_blocks_img` | ✓ | ✓ | `{ pngBase64 }` (server emits MCP `image` content) |
| `session_get_hex_file` | — | ✓ | base64 Universal Hex |
| `get_blocks_img_from_code` | ✓ | ✓ | `{ pngBase64 }` (stateless; server emits MCP `image` content) |
| `get_hex_file_from_code` | — | ✓ | base64 Universal Hex (stateless) |

`_from_code` tools are pure functions: same input always produces the same output, with no effect on editor state. `session_get_blocks_img` requires prior `session_set_code`; if the editor is empty, the executor throws a descriptive error so the LLM can self-correct. The browser target omits both hex tools on purpose: the user already has MakeCode's own Download button (and WebUSB flash) right next to the chat, so a `session_get_hex_file` tool would just be a slower, opaquer way to do something the UI already supports. On the server target hex stays useful because the LLM host (Claude Desktop, etc.) has no other path to the binary.

## Browser target

```tsx
import { MakeCodePanel, type BrowserExecutor } from "makecode-mcp/browser";

function App() {
  const [executor, setExecutor] = useState<BrowserExecutor | null>(null);
  return (
    <MakeCodePanel onExecutorReady={setExecutor} />
    // …pass `executor` to your chat runtime
  );
}
```

The executor is bound to the panel's iframe for the panel's lifetime. Loaded code persists across turns as long as the panel stays mounted. See [src/browser/](src/browser/) for the full API.

## Server target

The CLI starts a stdio MCP server:

```bash
# After build:
node dist/server/bin.js
# Or, once installed:
npx makecode-mcp
```

Point any MCP client (Claude Desktop, MCP Inspector, etc.) at the binary. For interactive exploration:

```bash
npm run dev:test-mcp -w makecode-mcp
```

That builds the package and launches the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) wired to the stdio server.

### Headed mode (watch the editor live)

By default the server runs Chromium headless. Pass `--headed` (or set `MKCP_HEADED=1`) at launch and the server's MakeCode editor opens in a visible OS window so you can watch the LLM drive it:

```bash
node dist/server/bin.js --headed
# or
MKCP_HEADED=1 node dist/server/bin.js
```

Notes:

- Headed mode is a launch-time choice. Chromium can't be toggled mid-process, so the flag fixes visibility for the whole server lifetime.
- There is one window for the whole server, not one per session. Sessions live in the server's memory, so there is nothing session-specific to show; the window is the shared editor every tool call passes through, including the stateless `*_from_code` previews.
- It opens as a real OS window (via CDP `Target.createTarget({ newWindow: true })`), not a tab in an existing window.
- Expect the window's content to jump between projects: consecutive calls from different sessions load their own code into it. What each session holds is unaffected by what you see.

### Server layering

Internally the server layers as:

```
bin.ts (CLI)
  └── buildMcpServer({ executor })
        └── SessionExecutor (implements ServerExecutor)
              ├── SessionStore               (session_id → project files, in memory)
              └── TabPool
                    └── PuppeteerTabPool
                          ├── browserPool: BrowserPool   (headless, or headed per --headed)
                          ├── PuppeteerDriver            (page.evaluate → window.__mkcp)
                          └── startShellServer()         (serves shell.html + bundled shim)
```

A session is a record in `SessionStore`, not a browser tab: `session_start` allocates one instantly and `session_end` drops it. Tools that need MakeCode (writes, hex, previews) borrow the one shared editor tab and load the relevant project into it first, so the browser cost is a single tab no matter how many sessions are open. See [src/server/](src/server/).

## Claude Desktop extension (.mcpb)

For Claude Desktop you can build a one-click installable `.mcpb` bundle instead of editing a JSON config:

```bash
npm install
npm run build:mcpb -w makecode-mcp
```

This stages the package into `packages/makecode-mcp/.mcpb-staging/`, installs runtime dependencies fresh (with Puppeteer's Chromium download skipped), and writes the bundle to `packages/makecode-mcp/dist/makecode-mcp.mcpb`. Double-click the file or drag it into Claude Desktop → Settings → Extensions to install.

The bundle ships only JavaScript and relies on a system-installed Chrome (or Chromium), which the server locates at startup via [`chrome-launcher`](https://www.npmjs.com/package/chrome-launcher). Two settings are exposed in Claude Desktop's extension UI:

- **Headed mode** — show the MakeCode editor in a visible browser window so you can watch it work. Off by default.
- **Chrome executable (optional)** — explicit path to a Chrome/Chromium binary. Leave blank to auto-detect.

If no Chrome install is found and no override is given, the server exits with a stderr message. Install Google Chrome (or Chromium) and try again.

## Configuring MCP clients

This package is private to the monorepo, so MCP clients launch it directly from `dist/server/bin.js` rather than via `npx`. Build the package first:

```bash
npm install
npm run build -w makecode-mcp
```

Then point your client at `node /absolute/path/to/microbit-web-llm/packages/makecode-mcp/dist/server/bin.js`. Replace the path in the snippets below with your checkout's absolute path.

### Claude Desktop and LM Studio

Both clients use the same `mcpServers` JSON shape. Add this entry to the relevant config file:

- **Claude Desktop** — `claude_desktop_config.json`
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- **LM Studio** (0.3.17+) — `~/.lmstudio/mcp.json`, or the **Program** tab's "Edit mcp.json" button.

```json
{
  "mcpServers": {
    "makecode-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/microbit-web-llm/packages/makecode-mcp/dist/server/bin.js"
      ]
    }
  }
}
```

Restart Claude Desktop after editing; the `session_start`, `session_set_code`, `session_get_blocks_img`, etc. tools appear in its tools menu. In LM Studio, start a chat with a tool-calling-capable model and enable the `makecode-mcp` server in the chat sidebar. Blocks images returned by `session_get_blocks_img*` render inline as PNGs in the conversation.

### GitHub Copilot (VS Code)

Copilot Chat in VS Code uses a different shape — `servers` with an explicit `type`. Add to `.vscode/mcp.json` (per-workspace) or your user `settings.json`:

```json
{
  "servers": {
    "makecode-mcp": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/microbit-web-llm/packages/makecode-mcp/dist/server/bin.js"
      ]
    }
  }
}
```

Open Copilot Chat in **Agent** mode, click the tools icon, and enable `makecode-mcp`. See VS Code's [MCP servers in Copilot](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) docs for details.

### Verifying the setup

If a client fails to connect, run the server through MCP Inspector to confirm it works in isolation:

```bash
npm run dev:test-mcp -w makecode-mcp
```

The Inspector UI lets you call each tool manually and inspect raw stdio traffic. See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector).

## Scripts

```bash
npm run build         -w makecode-mcp   # tsc -b
npm run test          -w makecode-mcp   # Vitest unit tests
npm run test:e2e      -w makecode-mcp   # Playwright integration tests
npm run dev:test-page -w makecode-mcp   # manual Vite smoke page for the browser target
npm run dev:test-mcp  -w makecode-mcp   # build + launch MCP Inspector against the server
npm run start:server  -w makecode-mcp   # run the stdio MCP server from dist/
```

## Layout

```
src/
├── shared/     ← tool schemas, types, project defaults, logger (single source of truth)
├── browser/    ← IframeExecutor + MakeCodePanel React component
└── server/     ← SessionExecutor, SessionStore, BrowserPool, MCP server, shell page + shim
test/           ← Vitest (unit) + Playwright (integration) tests
test-page/      ← manual smoke-test Vite entry for the browser target
```

Logging uses the shared logger at [src/shared/logger.ts](src/shared/logger.ts): one namespace per module, with previews for large payloads. Server code never writes to stdout (the MCP stdio transport owns it); the logger routes Node output to stderr.

For architectural rules and contribution guidelines see [../../AGENTS.md](../../AGENTS.md).
