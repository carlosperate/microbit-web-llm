import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/server/mcp-server.ts";
import { SessionError } from "../../src/shared/types.ts";
import type { ServerExecutor } from "../../src/shared/types.ts";
import { serverToolNames } from "../../src/shared/tools.ts";

function fakeExecutor(): ServerExecutor {
  let active: string | null = null;
  return {
    async startSession() {
      active = "sid-123";
      return { session_id: active };
    },
    async endSession(sid) {
      if (sid !== active) throw new SessionError("unknown", "nope");
      active = null;
    },
    async getCurrentCode(sid) {
      if (sid !== active) throw new SessionError("unknown", "nope");
      return "basic.showNumber(1)";
    },
    async setCode(sid) {
      if (sid !== active) throw new SessionError("unknown", "nope");
    },
    async getBlocksImage(sid) {
      if (sid !== active) throw new SessionError("unknown", "nope");
      return { pngBase64: "iVBORw0KGgo=" };
    },
    async getHexFile(sid) {
      if (sid !== active) throw new SessionError("unknown", "nope");
      return "aGV4";
    },
    async getBlocksImageFromCode() {
      return { pngBase64: "iVBORw0KGgoX" };
    },
    async getHexFileFromCode() {
      return "aGV4Mg==";
    },
  };
}

async function connect(exec: ServerExecutor) {
  const server = buildMcpServer({ executor: exec });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe("McpServer", () => {
  let client: Awaited<ReturnType<typeof connect>>["client"];
  beforeEach(async () => {
    ({ client } = await connect(fakeExecutor()));
  });

  it("lists all eight tools from the shared schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...serverToolNames].sort());
  });

  it("calls session_start and returns the session_id as JSON text", async () => {
    const res = await client.callTool({ name: "session_start", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ session_id: "sid-123" });
  });

  it("session errors surface as isError with code", async () => {
    const res = await client.callTool({
      name: "session_get_code",
      arguments: { session_id: "wrong" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe("unknown");
    expect(parsed.error).toMatch(/nope/);
  });

  it("get_blocks_img_from_code returns an MCP image content block", async () => {
    const res = await client.callTool({
      name: "get_blocks_img_from_code",
      arguments: { code: "x" },
    });
    const content = res.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "image",
      data: "iVBORw0KGgoX",
      mimeType: "image/png",
    });
  });

  // LM Studio + vision-context fence: the base64 image content block is the
  // fallback path for non-MCP-Apps hosts and the only way the model sees the
  // pixels. A future refactor that drops this in favour of MCP Apps alone
  // would regress LM Studio and break vision context — this test fences it.
  it("session_get_blocks_img returns an MCP image content block (LM Studio + vision-context fallback fence)", async () => {
    const startRes = await client.callTool({ name: "session_start", arguments: {} });
    const startText = (startRes.content as Array<{ type: string; text: string }>)[0].text;
    const { session_id } = JSON.parse(startText);

    const res = await client.callTool({
      name: "session_get_blocks_img",
      arguments: { session_id },
    });
    const content = res.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("attaches _meta.ui.resourceUri to the two image tools (and only those) so MCP Apps hosts render them inline", async () => {
    const { tools } = await client.listTools();
    const byName = (n: string) => tools.find((t) => t.name === n);
    const expectedUri = "ui://makecode-mcp/blocks-viewer.html";

    const imgSession = byName("session_get_blocks_img");
    const imgFromCode = byName("get_blocks_img_from_code");
    expect(imgSession).toBeDefined();
    expect(imgFromCode).toBeDefined();
    expect((imgSession as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui?.resourceUri).toBe(
      expectedUri,
    );
    expect((imgFromCode as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui?.resourceUri).toBe(
      expectedUri,
    );

    // Defensive: no other tool should advertise _meta. If a future change adds
    // _meta elsewhere, update this assertion deliberately rather than letting
    // it silently spread.
    for (const t of tools) {
      if (t.name === "session_get_blocks_img" || t.name === "get_blocks_img_from_code") continue;
      expect((t as { _meta?: unknown })._meta).toBeUndefined();
    }
  });

  it("registers the blocks-viewer ui:// resource and serves the widget HTML", async () => {
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("ui://makecode-mcp/blocks-viewer.html");
    expect(resources[0].mimeType).toBe("text/html;profile=mcp-app");

    const read = await client.readResource({
      uri: "ui://makecode-mcp/blocks-viewer.html",
    });
    expect(read.contents).toHaveLength(1);
    const item = read.contents[0] as { text?: string; mimeType?: string; uri?: string };
    expect(item.mimeType).toBe("text/html;profile=mcp-app");
    expect(item.uri).toBe("ui://makecode-mcp/blocks-viewer.html");
    expect(item.text).toMatch(/<!-- makecode-blocks-viewer:v1 -->/);
  });
});
