import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createWidgetChannel, type WidgetChannel } from "../../src/server/widget-channel.ts";
import { SessionStore } from "../../src/server/session-store.ts";
import { ViewRegistry } from "../../src/server/view-registry.ts";

const TOKEN = "test-token";

interface Harness {
  origin: string;
  store: SessionStore;
  views: ViewRegistry;
  channel: WidgetChannel;
  close: () => Promise<void>;
}

const open: Harness[] = [];
const streams: AbortController[] = [];

afterEach(async () => {
  for (const c of streams.splice(0)) c.abort();
  for (const h of open.splice(0)) await h.close();
});

async function harness(): Promise<Harness> {
  const store = new SessionStore();
  const views = new ViewRegistry();
  let channel!: WidgetChannel;
  const server: Server = createServer((req, res) => {
    if (!channel.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${addr.port}`;
  channel = createWidgetChannel({ store, views, token: TOKEN, origin });
  const h: Harness = {
    origin,
    store,
    views,
    channel,
    close: async () => {
      channel.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  open.push(h);
  return h;
}

/** Reads an SSE stream, exposing the decoded messages as they arrive. */
function listen(url: string) {
  const ac = new AbortController();
  streams.push(ac);
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  const status = fetch(url, { signal: ac.signal }).then(async (res) => {
    if (!res.ok || !res.body) return res.status;
    (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          messages.push(JSON.parse(line.slice(5).trim()));
          for (const w of waiters.splice(0)) w();
        }
      }
    })().catch(() => {});
    return res.status;
  });
  return {
    status,
    messages,
    async waitFor(count: number, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} messages, got ${messages.length}`);
        }
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 25);
        });
      }
      return messages;
    },
    stop: () => ac.abort(),
  };
}

const eventsUrl = (h: Harness, session: string, view = "v1", token = TOKEN) =>
  `${h.origin}/widget/events?session=${session}&token=${token}&view=${view}`;

const save = (h: Harness, session: string, body: unknown, view = "v1", token = TOKEN) =>
  fetch(`${h.origin}/widget/save?session=${session}&token=${token}&view=${view}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("widget channel — attach and hydrate", () => {
  it("sends the session's current project as the first event", async () => {
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "basic.showNumber(1)" } });
    const es = listen(eventsUrl(h, "s1"));
    const [first] = await es.waitFor(1);
    expect(first).toMatchObject({
      type: "project",
      version: 0,
      files: { "main.ts": "basic.showNumber(1)" },
    });
    expect(h.views.countFor("s1")).toBe(1);
  });

  it("pushes tool-driven commits to the attached view", async () => {
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "" } });
    const es = listen(eventsUrl(h, "s1"));
    await es.waitFor(1);
    h.store.commit("s1", { "main.ts": "basic.showString(\"hi\")" });
    const msgs = await es.waitFor(2);
    expect(msgs[1]).toMatchObject({
      type: "project",
      version: 1,
      files: { "main.ts": 'basic.showString("hi")' },
    });
  });

  it("does not echo a commit back to the view that made it", async () => {
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "" } });
    const es = listen(eventsUrl(h, "s1", "viewA"));
    await es.waitFor(1);
    h.store.commit("s1", { "main.ts": "user edit" }, "viewA");
    h.store.commit("s1", { "main.ts": "tool write" });
    const msgs = await es.waitFor(2);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ files: { "main.ts": "tool write" } });
  });

  it("tells the view when its session goes away", async () => {
    const h = await harness();
    h.store.create("s1", { files: {} });
    const es = listen(eventsUrl(h, "s1"));
    await es.waitFor(1);
    h.store.delete("s1");
    const msgs = await es.waitFor(2);
    expect(msgs[1]).toEqual({ type: "session-gone" });
    expect(h.views.countFor("s1")).toBe(0);
  });

  it("reports session-gone immediately for an unknown session", async () => {
    const h = await harness();
    const es = listen(eventsUrl(h, "nope"));
    const [first] = await es.waitFor(1);
    expect(first).toEqual({ type: "session-gone" });
  });

  it("drops the view when the stream disconnects", async () => {
    const h = await harness();
    h.store.create("s1", { files: {} });
    const es = listen(eventsUrl(h, "s1"));
    await es.waitFor(1);
    expect(h.views.countFor("s1")).toBe(1);
    es.stop();
    const deadline = Date.now() + 2000;
    while (h.views.countFor("s1") > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.views.countFor("s1")).toBe(0);
  });
});

describe("widget channel — user edits", () => {
  it("commits a save into the store, tagged with the view", async () => {
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "old" } });
    const changes: unknown[] = [];
    h.store.subscribe((c) => changes.push(c));

    const res = await save(h, "s1", { baseVersion: 0, files: { "main.ts": "dragged" } }, "viewA");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: 1 });
    expect(h.store.get("s1")!.files["main.ts"]).toBe("dragged");
    expect(changes[0]).toMatchObject({ source: "viewA" });
  });

  it("accepts a save that raced a tool write (last write wins) ", async () => {
    // Documented behaviour: the user is asking the assistant to edit on their
    // behalf, so whichever lands last is the one they meant.
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "v0" } });
    h.store.commit("s1", { "main.ts": "tool wrote this" });
    const res = await save(h, "s1", { baseVersion: 0, files: { "main.ts": "user had this" } });
    expect(res.status).toBe(200);
    expect(h.store.get("s1")!.files["main.ts"]).toBe("user had this");
  });

  it("rejects a save for an unknown session without touching the store", async () => {
    const h = await harness();
    const res = await save(h, "gone", { files: { "main.ts": "x" } });
    expect(res.status).toBe(404);
    expect(h.store.size).toBe(0);
  });

  it("rejects a body that isn't a file map", async () => {
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "keep" } });
    const res = await save(h, "s1", { files: "not an object" });
    expect(res.status).toBe(400);
    expect(h.store.get("s1")!.files["main.ts"]).toBe("keep");
  });

  it("rejects an oversized body instead of buffering it", async () => {
    const h = await harness();
    h.store.create("s1", { files: {} });
    const huge = "x".repeat(9 * 1024 * 1024);
    const res = await save(h, "s1", { files: { "main.ts": huge } });
    expect(res.status).toBe(413);
    expect(h.store.get("s1")!.version).toBe(0);
  });
});

describe("widget channel — access control", () => {
  it("rejects a wrong token on both routes", async () => {
    const h = await harness();
    h.store.create("s1", { files: {} });
    const es = listen(eventsUrl(h, "s1", "v1", "wrong"));
    await expect(es.status).resolves.toBe(403);
    const res = await save(h, "s1", { files: {} }, "v1", "wrong");
    expect(res.status).toBe(403);
  });

  it("accepts a foreign origin that has the token, and refuses one that doesn't", async () => {
    // A view is served by the host at an origin we can't predict, so Origin is
    // not something we can check against. The token is the gate: a site the
    // user happens to have open can guess the port but not a startup UUID.
    const h = await harness();
    h.store.create("s1", { files: { "main.ts": "keep" } });
    const post = (token: string, code: string) =>
      fetch(`${h.origin}/widget/save?session=s1&token=${token}&view=v1`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://host.example" },
        body: JSON.stringify({ files: { "main.ts": code } }),
      });

    expect((await post("wrong-token", "pwned")).status).toBe(403);
    expect(h.store.get("s1")!.files["main.ts"]).toBe("keep");

    const ok = await post(TOKEN, "from the widget");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://host.example");
    expect(h.store.get("s1")!.files["main.ts"]).toBe("from the widget");
  });

  it("leaves non-widget paths to the rest of the server", async () => {
    const h = await harness();
    const res = await fetch(`${h.origin}/shell.html`);
    expect(res.status).toBe(404); // the harness's fallback, i.e. not handled here
  });
});
