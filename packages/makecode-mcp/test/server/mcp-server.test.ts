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

const BRIDGE = {
  token: "tok-1",
  origin: "http://127.0.0.1:54321",
};

async function connect(exec: ServerExecutor, editorBridge?: typeof BRIDGE) {
  const server = buildMcpServer({
    executor: exec,
    ...(editorBridge ? { editorBridge } : {}),
  });
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

  it("leaves the live-editor widget unregistered when no bridge is configured", async () => {
    // Without a shell server there is no origin to frame, so advertising the
    // widget would hand hosts a resource that can't load.
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("ui://makecode-mcp/editor.html");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
  });
});

describe("McpServer — live session editor widget", () => {
  let client: Awaited<ReturnType<typeof connect>>["client"];
  beforeEach(async () => {
    ({ client } = await connect(fakeExecutor(), BRIDGE));
  });

  it("registers the editor resource and lets the widget frame the bridge origin", async () => {
    // This CSP is the one host-side permission the whole design rests on: the
    // widget must be allowed to iframe our localhost server.
    const { resources } = await client.listResources();
    const editor = resources.find((r) => r.uri === "ui://makecode-mcp/editor.html");
    expect(editor).toBeDefined();
    expect(editor!.mimeType).toBe("text/html;profile=mcp-app");
    const csp = (editor as { _meta?: { ui?: { csp?: { frameDomains?: string[] } } } })._meta?.ui
      ?.csp;
    // blob: is what actually matters now — the widget hosts MakeCode in a blob
    // iframe rather than framing our server.
    expect(csp?.frameDomains).toContain("blob:");
    expect(csp?.frameDomains).toContain(BRIDGE.origin);
  });

  it("serves the widget with the server origin and token filled in", async () => {
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toMatch(/<!-- makecode-session-editor:v2 -->/);
    expect(text).toContain(BRIDGE.origin);
    expect(text).toContain(BRIDGE.token);
  });

  it("repeats the CSP on the read result, where the host looks at render time", async () => {
    // resources/list is not enough: Claude Desktop reads the resource right
    // before rendering, and a missing csp there means frame-src 'none'.
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    const cspOf = (v: unknown) =>
      (v as { _meta?: { ui?: { csp?: { frameDomains?: string[] } } } })?._meta?.ui?.csp;
    expect(cspOf(read)?.frameDomains).toContain("blob:");
    expect(cspOf(read.contents[0])?.frameDomains).toContain("blob:");
  });

  it("also declares the CSP under ChatGPT's legacy widgetCSP key", async () => {
    // ChatGPT reads _meta["openai/widgetCSP"] (snake_case) alongside the
    // standard _meta.ui.csp. Sending only the standard key leaves it granting
    // no frame domains at all.
    const legacyOf = (v: unknown) =>
      (v as { _meta?: Record<string, { frame_domains?: string[]; connect_domains?: string[] }> })
        ?._meta?.["openai/widgetCSP"];
    const { resources } = await client.listResources();
    const editor = resources.find((r) => r.uri === "ui://makecode-mcp/editor.html");
    expect(legacyOf(editor)?.frame_domains).toContain("blob:");
    expect(legacyOf(editor)?.connect_domains).toContain(BRIDGE.origin);
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    expect(legacyOf(read)?.frame_domains).toContain("blob:");
    expect(legacyOf(read.contents[0])?.frame_domains).toContain("blob:");
  });

  it("declares the origins the in-page editor needs, and blob: for its frame", async () => {
    // The widget hosts MakeCode in a blob iframe. A spec-compliant host builds
    // frame-src from frameDomains, so omitting blob: would give frame-src
    // 'none' and block our own frame; MakeCode's scripts and XHRs come from its
    // CDN, so those origins have to be declared too.
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    const csp = (read as { _meta?: { ui?: { csp?: Record<string, string[]> } } })._meta?.ui?.csp;
    expect(csp?.frameDomains).toContain("blob:");
    // MakeCode ships fonts and images as data: URIs; img-src/font-src come
    // from resourceDomains alone, so the schemes have to be declared there.
    expect(csp?.resourceDomains).toContain("data:");
    expect(csp?.resourceDomains).toContain("blob:");
    for (const field of ["connectDomains", "resourceDomains"] as const) {
      expect(csp?.[field]).toContain("https://makecode.microbit.org");
      expect(csp?.[field]).toContain("https://cdn.makecode.com");
      expect(csp?.[field]).toContain(BRIDGE.origin);
    }
  });

  it("inlines its script and config, since our origin may not be in script-src", async () => {
    const read = await client.readResource({ uri: "ui://makecode-mcp/editor.html" });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).not.toContain("__MKCP_APP_JS__");
    expect(text).not.toContain("__MKCP_CONFIG__");
    expect(text).toContain(BRIDGE.origin);
  });

  it("points session_start and session_set_code at the editor widget", async () => {
    const { tools } = await client.listTools();
    const uriOf = (n: string) =>
      (tools.find((t) => t.name === n) as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui
        ?.resourceUri;
    expect(uriOf("session_start")).toBe("ui://makecode-mcp/editor.html");
    // Only session_start opens one. The editor is live, so a widget attached at
    // session_start already shows a later session_set_code over its SSE stream;
    // advertising it again just opens a second editor in the conversation.
    expect(uriOf("session_set_code")).toBeUndefined();
    // The image tools keep their own widget: a PNG in the message is still the
    // right thing for "show me the blocks".
    expect(uriOf("session_get_blocks_img")).toBe("ui://makecode-mcp/blocks-viewer.html");
  });

  it("echoes the session_id from session_set_code so the widget knows what to show", async () => {
    // A widget created (or re-created) by this call has only the tool result
    // to learn the session from.
    const { session_id } = JSON.parse(
      ((await client.callTool({ name: "session_start", arguments: {} })) as never as {
        content: { text: string }[];
      }).content[0].text,
    );
    const res = (await client.callTool({
      name: "session_set_code",
      arguments: { session_id, code: "basic.showNumber(1)" },
    })) as never as { content: { text: string }[] };
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, session_id });
  });
});
