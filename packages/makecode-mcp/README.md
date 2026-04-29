# makecode-mcp

A TypeScript library that exposes the [MakeCode micro:bit editor](https://makecode.microbit.org/) to LLMs through a small, stable tool surface. Ships two targets from a single codebase:

- **`makecode-mcp/browser`** — a React `MakeCodePanel` component and a stateless `IframeExecutor` for driving an embedded MakeCode iframe from an in-browser LLM.
- **`makecode-mcp/server`** — a Node.js binary (`makecode-mcp`) that runs as a stdio [Model Context Protocol](https://modelcontextprotocol.io) server, using Puppeteer to host one MakeCode tab per LLM session.

All MakeCode integration goes through [`@microbit/makecode-embed`](https://github.com/microbit-foundation/makecode-embed) — no hand-rolled `postMessage`.

## Install

This package is private to the monorepo and consumed via npm workspaces. From the repo root:

```bash
npm install
npm run build -w makecode-mcp
```

## Two targets, two interfaces

The browser and server targets have deliberately different shapes, each matched to how it's used:

| | **`BrowserExecutor`** | **`ServerExecutor`** |
|---|---|---|
| Session model | One executor = one iframe = one session. The iframe *is* the session. | One process serves many clients; each holds an opaque `session_id` mapped to a Puppeteer tab. |
| Tools exposed | 6 (no `session_id`) | 8 (stateful tools take `session_id`, plus `start_session` / `end_session`) |
| Import | `import { IframeExecutor, MakeCodePanel } from "makecode-mcp/browser"` | `import { buildMcpServer, TabExecutor } from "makecode-mcp/server"` |

Never import from `makecode-mcp/server` in browser code and vice versa.

### Shared tools

Both targets expose the same core operations. Descriptions live in [src/shared/tools.ts](src/shared/tools.ts).

| Tool | Browser | Server | Returns |
|---|---|---|---|
| `start_session` | — | ✓ | `{ session_id }` |
| `end_session` | — | ✓ | void |
| `get_current_code` | ✓ | ✓ | TypeScript source |
| `set_code` | ✓ | ✓ | void |
| `get_blocks_image` | ✓ | ✓ | `{ pngBase64 }` (server emits MCP `image` content) |
| `get_hex_file` | ✓ | ✓ | base64 Universal Hex |
| `get_blocks_image_from_code` | ✓ | ✓ | `{ pngBase64 }` (stateless; server emits MCP `image` content) |
| `get_hex_file_from_code` | — | ✓ | base64 Universal Hex (stateless) |

`_from_code` tools are pure functions: same input always produces the same output, with no effect on editor state. `get_blocks_image` requires prior `set_code` — the executor throws a descriptive error for the LLM to self-correct when the editor is empty. The browser target intentionally omits `get_hex_file_from_code`: the equivalent path is `set_code` + `get_hex_file`, which the system prompt directs the model toward.

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

Internally the server layers as:

```
bin.ts (CLI)
  └── buildMcpServer({ executor })
        └── TabExecutor (implements ServerExecutor)
              └── TabPool
                    └── PuppeteerTabPool
                          ├── BrowserPool        (one Puppeteer process, reused)
                          ├── PuppeteerDriver    (page.evaluate → window.__mkcp)
                          └── startShellServer() (serves shell.html + bundled shim)
```

Each `start_session` allocates a Puppeteer tab loading a local shell page; `end_session` closes the tab. The browser process itself stays alive between sessions. See [src/server/](src/server/).

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

Restart Claude Desktop after editing; the `start_session`, `set_code`, `get_blocks_image`, etc. tools appear in its tools menu. In LM Studio, start a chat with a tool-calling-capable model and enable the `makecode-mcp` server in the chat sidebar — Blocks images returned by `get_blocks_image*` render inline as PNGs in the conversation.

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
└── server/     ← TabExecutor, BrowserPool, MCP server, shell page + shim
test/           ← Vitest (unit) + Playwright (integration) tests
test-page/      ← manual smoke-test Vite entry for the browser target
```

Logging uses the shared logger at [src/shared/logger.ts](src/shared/logger.ts) — one namespace per module, with previews for large payloads. Server code never writes to stdout (the MCP stdio transport owns it); the logger routes Node output to stderr.

For architectural rules and contribution guidelines see [../../AGENTS.md](../../AGENTS.md).
