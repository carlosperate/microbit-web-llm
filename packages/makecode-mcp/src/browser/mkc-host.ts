// Browser Host + Cache for pxt-mkc (makecode-core), modelled on
// microsoft/vscode-makecode's web host: in-memory FS for the throwaway
// project/built files, fetch for downloads, Cache API for the ~4.6 MB
// editor bundle so it survives reloads. Consumed only by local-compiler.ts.
import type {
  Host,
  HttpRequestOptions,
  HttpResponse,
  LanguageService,
} from "makecode-core/built/host";
import type { Cache, DownloadedEditor } from "makecode-core/built/mkc";
import { createLogger } from "../shared/logger.js";

// Namespace shared with local-compiler.ts: one DevTools signature for the
// whole local-compile subsystem.
const log = createLogger("local-compiler");

export interface MemoryHost {
  host: Host;
  seedFile(path: string, content: string): void;
}

export interface MemoryHostOptions {
  /** Must be sync-fast (preload makecode-browser first): mkc's Ctx
   *  fire-and-forgets its init, and a slow factory loses the race against
   *  the first compile. */
  createLanguageService: (editor: DownloadedEditor) => LanguageService;
  fetchImpl?: typeof fetch;
}

const td = new TextDecoder();
const te = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// mkc resolves project paths absolute ("/prj/pxt.json"); store them relative.
const norm = (p: string) => p.replace(/^\/+/, "").replace(/^\.\//, "");

export function createMemoryHost(opts: MemoryHostOptions): MemoryHost {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const memFs = new Map<string, string | Uint8Array>();

  const requestAsync = async (options: HttpRequestOptions): Promise<HttpResponse> => {
    const method = options.method || (options.data == null ? "GET" : "POST");
    const headers = new Headers();
    for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k, v);
    let body: BodyInit | null = null;
    if (options.data != null) {
      if (typeof options.data === "string" || options.data instanceof Uint8Array) {
        body = options.data as BodyInit;
      } else {
        body = JSON.stringify(options.data);
        headers.set("content-type", "application/json; charset=utf8");
      }
    }
    const start = performance.now();
    const resp = await fetchImpl(options.url, { method, headers, body });
    const buffer = new Uint8Array(await resp.arrayBuffer());
    // Prefixed fetch trace. mkc's downloader also prints bare "Download <url>"
    // console.log lines its setLogging hook can't reach (module-private log fn
    // in the published build); these lines are the canonical, identifiable ones.
    log.info(
      `${method} ${options.url} → ${resp.status} (${buffer.length}B, ${Math.round(performance.now() - start)}ms)`,
    );
    let text: string | undefined;
    try {
      text = td.decode(buffer);
    } catch {
      // binary body
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => (hdrs[k.toLowerCase()] = v));
    return { statusCode: resp.status, headers: hdrs, buffer, text, json };
  };

  const host: Host = {
    readFileAsync: (async (p: string, encoding?: "utf8") => {
      const v = memFs.get(norm(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      if (encoding === "utf8") return typeof v === "string" ? v : td.decode(v);
      return typeof v === "string" ? te.encode(v) : v;
    }) as Host["readFileAsync"],
    writeFileAsync: async (p, content, encoding) => {
      if (encoding === "base64") memFs.set(norm(p), base64ToBytes(content as string));
      else if (typeof content === "string") memFs.set(norm(p), content);
      else memFs.set(norm(p), content as Uint8Array);
    },
    mkdirAsync: async () => {},
    rmdirAsync: async () => {},
    existsAsync: async (p) => {
      const n = norm(p);
      if (memFs.has(n)) return true;
      for (const k of memFs.keys()) if (k.startsWith(n + "/")) return true;
      return false;
    },
    unlinkAsync: async (p) => {
      memFs.delete(norm(p));
    },
    symlinkAsync: async () => {},
    listFilesAsync: async (directory, filename) => {
      const d = norm(directory);
      const out: string[] = [];
      for (const k of memFs.keys()) {
        if ((d === "" || k.startsWith(d + "/")) && k.split("/").pop() === filename) out.push(k);
      }
      return out;
    },
    cwdAsync: async () => "/",
    requestAsync,
    createLanguageServiceAsync: async (editor: DownloadedEditor) =>
      opts.createLanguageService(editor),
    getDeployDrivesAsync: async () => [],
    getEnvironmentVariable: () => "",
    exitWithStatus: (code) => {
      throw new Error(`mkc exitWithStatus(${code})`);
    },
    bufferToString: (buffer) => td.decode(buffer),
    stringToBuffer: (str, encoding) => (encoding === "base64" ? base64ToBytes(str) : te.encode(str)),
    base64EncodeBufferAsync: async (buffer) => {
      const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) {
        s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      }
      return btoa(s);
    },
  };

  return { host, seedFile: (p, c) => memFs.set(norm(p), c) };
}

const CACHE_NAME = "mkcp-mkc-editor";
// mkc cache keys are arbitrary strings; the Cache API needs URL keys.
const keyUrl = (key: string) => `https://mkcp-cache.invalid/${encodeURIComponent(key)}`;

/** mkc Cache backed by the Cache API (in-memory fallback). Never sets
 *  `rootPath`: that flag switches mkc's downloader into the Node-CLI branch
 *  that fetches sim/asseteditor pages (and contains a URL-join bug). */
export function createMkcCache(cacheStorage: CacheStorage | undefined = globalThis.caches): Cache {
  if (!cacheStorage) {
    const mem = new Map<string, Uint8Array>();
    return {
      getAsync: async (key) => (mem.get(key) ?? null) as unknown as Uint8Array,
      setAsync: async (key, val) => {
        mem.set(key, val);
      },
    };
  }
  return {
    getAsync: async (key) => {
      try {
        const cache = await cacheStorage.open(CACHE_NAME);
        const resp = await cache.match(keyUrl(key));
        if (!resp) return null as unknown as Uint8Array;
        return new Uint8Array(await resp.arrayBuffer());
      } catch {
        return null as unknown as Uint8Array;
      }
    },
    setAsync: async (key, val) => {
      try {
        const cache = await cacheStorage.open(CACHE_NAME);
        await cache.put(keyUrl(key), new Response(val as BodyInit));
      } catch {
        // Cache API unavailable (private browsing quota etc.): next call re-downloads.
      }
    },
  };
}
