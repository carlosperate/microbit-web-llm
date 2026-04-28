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

  it("calls start_session and returns the session_id as JSON text", async () => {
    const res = await client.callTool({ name: "start_session", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ session_id: "sid-123" });
  });

  it("session errors surface as isError with code", async () => {
    const res = await client.callTool({
      name: "get_current_code",
      arguments: { session_id: "wrong" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe("unknown");
    expect(parsed.error).toMatch(/nope/);
  });

  it("get_blocks_image_from_code returns an MCP image content block", async () => {
    const res = await client.callTool({
      name: "get_blocks_image_from_code",
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
});
