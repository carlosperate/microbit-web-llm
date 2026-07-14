import { describe, it, expect, vi } from "vitest";
import { createMemoryHost, createMkcCache, type MemoryHostOptions } from "../../src/browser/mkc-host.ts";

// The factory is required (and sync-fast by contract); FS/request tests don't use it.
const dummyLs = (() => ({})) as unknown as MemoryHostOptions["createLanguageService"];
const mkHost = (opts: Partial<MemoryHostOptions> = {}) =>
  createMemoryHost({ createLanguageService: dummyLs, ...opts });

describe("createMemoryHost — in-memory FS", () => {
  it("round-trips seeded utf8 files and normalizes leading slashes", async () => {
    const { host, seedFile } = mkHost();
    seedFile("prj/pxt.json", "{}");
    await expect(host.readFileAsync("prj/pxt.json", "utf8")).resolves.toBe("{}");
    // mkc resolves paths absolute ("/prj/...") via path.resolve; same file.
    await expect(host.readFileAsync("/prj/pxt.json", "utf8")).resolves.toBe("{}");
  });

  it("throws for missing files (mkc.json fallback read relies on rejection)", async () => {
    const { host } = mkHost();
    await expect(host.readFileAsync("prj/mkc.json", "utf8")).rejects.toThrow(/prj\/mkc\.json/);
  });

  it("writeFileAsync base64 stores bytes readable without encoding", async () => {
    const { host } = mkHost();
    await host.writeFileAsync("built/binary.uf2", btoa("HEX!"), "base64");
    const bytes = (await host.readFileAsync("built/binary.uf2")) as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toBe("HEX!");
  });

  it("existsAsync sees files and implicit directories", async () => {
    const { host, seedFile } = mkHost();
    seedFile("prj/main.ts", "x");
    await expect(host.existsAsync("prj/main.ts")).resolves.toBe(true);
    await expect(host.existsAsync("prj")).resolves.toBe(true);
    await expect(host.existsAsync("nope")).resolves.toBe(false);
  });

  it("listFilesAsync finds files by exact name under a directory", async () => {
    const { host, seedFile } = mkHost();
    seedFile("prj/pxt.json", "{}");
    seedFile("prj/sub/pxt.json", "{}");
    seedFile("prj/main.ts", "");
    await expect(host.listFilesAsync("prj", "pxt.json")).resolves.toEqual([
      "prj/pxt.json",
      "prj/sub/pxt.json",
    ]);
  });

  it("unlinkAsync removes a file", async () => {
    const { host, seedFile } = mkHost();
    seedFile("a.txt", "x");
    await host.unlinkAsync("a.txt");
    await expect(host.existsAsync("a.txt")).resolves.toBe(false);
  });

  it("string/buffer codecs round-trip utf8 and base64", async () => {
    const { host } = mkHost();
    expect(host.bufferToString(host.stringToBuffer("hej"))).toBe("hej");
    const bytes = host.stringToBuffer(btoa("\x00\x01\xff binary"), "base64");
    expect(await host.base64EncodeBufferAsync(bytes)).toBe(btoa("\x00\x01\xff binary"));
  });
});

describe("createMemoryHost — language service factory", () => {
  it("delegates createLanguageServiceAsync to the injected factory", async () => {
    const ls = { fake: true };
    const factory = vi.fn(() => ls) as unknown as MemoryHostOptions["createLanguageService"];
    const { host } = createMemoryHost({ createLanguageService: factory });
    const editor = { versionNumber: 1 };
    await expect(host.createLanguageServiceAsync(editor as never)).resolves.toBe(ls);
    expect(factory).toHaveBeenCalledWith(editor);
  });
});

describe("createMemoryHost — requestAsync", () => {
  it("GETs via the injected fetch and exposes status/text/json/buffer", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"ok":1}', { status: 200, headers: { etag: "abc" } }),
    );
    const { host } = mkHost({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await host.requestAsync({ url: "https://cdn.makecode.com/x" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('{"ok":1}');
    expect(res.json).toEqual({ ok: 1 });
    expect(res.headers["etag"]).toBe("abc");
    expect(new TextDecoder().decode(res.buffer as Uint8Array)).toBe('{"ok":1}');
  });

  it("POSTs object data as JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const { host } = mkHost({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await host.requestAsync({ url: "https://x", data: { a: 1 } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get("content-type")).toMatch(/application\/json/);
  });
});

// Fake CacheStorage: put() buffers bytes so repeated match() reads work like
// the real Cache API (which clones responses).
function fakeCaches() {
  const store = new Map<string, Uint8Array>();
  const cache = {
    match: async (url: string) => {
      const bytes = store.get(url);
      return bytes ? new Response(bytes.slice()) : undefined;
    },
    put: async (url: string, resp: Response) => {
      store.set(url, new Uint8Array(await resp.arrayBuffer()));
    },
  };
  return { caches: { open: async () => cache } as unknown as CacheStorage, store };
}

describe("createMkcCache", () => {
  it("round-trips values through the Cache API keyed by encoded URL", async () => {
    const { caches, store } = fakeCaches();
    const cache = createMkcCache(caches);
    await cache.setAsync("https://makecode.microbit.org/-pxtworker.js", new TextEncoder().encode("w"));
    const got = await cache.getAsync("https://makecode.microbit.org/-pxtworker.js");
    expect(new TextDecoder().decode(got!)).toBe("w");
    // Keys must be valid URLs on a synthetic origin.
    expect([...store.keys()][0]).toMatch(/^https:\/\/mkcp-cache\.invalid\//);
    // Repeated reads keep working.
    expect(await cache.getAsync("https://makecode.microbit.org/-pxtworker.js")).toBeTruthy();
  });

  it("returns null on a miss", async () => {
    const { caches } = fakeCaches();
    const cache = createMkcCache(caches);
    expect(await cache.getAsync("nope")).toBeNull();
  });

  it("falls back to an in-memory map when the Cache API is unavailable", async () => {
    const cache = createMkcCache(undefined);
    expect(await cache.getAsync("k")).toBeNull();
    await cache.setAsync("k", new TextEncoder().encode("v"));
    expect(new TextDecoder().decode((await cache.getAsync("k"))!)).toBe("v");
  });

  it("never sets rootPath (the sim/asseteditor download branch must stay off)", () => {
    const { caches } = fakeCaches();
    expect(createMkcCache(caches).rootPath).toBeUndefined();
    expect(createMkcCache(undefined).rootPath).toBeUndefined();
  });
});
