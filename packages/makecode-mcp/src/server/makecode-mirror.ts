import { createLogger } from "../shared/logger.js";
import {
  SIM_URL_PLACEHOLDER,
  WORKER_URL_PLACEHOLDER,
} from "../shared/makecode-mirror-contract.js";

// Serves MakeCode's own pages from our origin so a view can host them in a
// `blob:` iframe. Hosts that forbid third-party frames (Claude) still allow
// `blob:`, and a blob frame is a real iframe, which is what MakeCode requires
// before it will enter controller mode.
const log = createLogger("makecode-mirror");

export const MAKECODE_ORIGIN = "https://makecode.microbit.org";
export const SIM_ORIGIN = "https://trg-microbit.userpxt.io";
export const CDN_ORIGIN = "https://cdn.makecode.com";

/** Replaced by the view with `blob:` URLs it mints at runtime. */
export {
  SIM_URL_PLACEHOLDER,
  WORKER_URL_PLACEHOLDER,
} from "../shared/makecode-mirror-contract.js";

// A blob document has no query string, so `controller=2` travels in the
// fragment. MakeCode rewrites the hash to `#editor` while starting up and only
// then evaluates the mode, so we force the (memoising) check to run first.
const FORCE_CONTROLLER = `<script>try{pxt.shell.isControllerMode();}catch(e){console.error("[mkcp] controller memoize failed",e);}</script>`;

const absolutize = (html: string, origin: string): string =>
  html.replace(/(src|href)="\/(?!\/)/g, `$1="${origin}/`).replace(/"\/---/g, `"${origin}/---`);

/** MakeCode's editor page, ready to be turned into a `blob:` document. */
export function rewriteEditorHtml(html: string): string {
  let out = absolutize(html, MAKECODE_ORIGIN);
  // Workers can't be cross-origin and the simulator's origin is framed by
  // nobody, so both are redirected to blob URLs the view builds.
  out = out
    .replace(new RegExp(`"${SIM_ORIGIN}/---simulator"`, "g"), `"${SIM_URL_PLACEHOLDER}"`)
    .replace(new RegExp(`"${MAKECODE_ORIGIN}/---worker"`, "g"), `"${WORKER_URL_PLACEHOLDER}"`)
    .replace(/"\/---worker"/g, `"${WORKER_URL_PLACEHOLDER}"`);
  // Fail loudly here rather than shipping a page that hangs in the widget: a
  // missed worker stays cross-origin (refused outright) and a missed simulator
  // points at an origin no host will frame.
  if (!out.includes(WORKER_URL_PLACEHOLDER))
    throw new Error("MakeCode page: no worker reference to redirect; the mirror needs updating");
  if (!out.includes(SIM_URL_PLACEHOLDER))
    throw new Error("MakeCode page: no simulator reference to redirect; the mirror needs updating");
  const main = out.indexOf('<script id="mainscript"');
  if (main === -1) throw new Error("MakeCode page has no #mainscript; the mirror needs updating");
  return out.slice(0, main) + FORCE_CONTROLLER + out.slice(main);
}

/** MakeCode's simulator page, ready to be turned into a `blob:` document. */
export function rewriteSimulatorHtml(html: string): string {
  return absolutize(html, SIM_ORIGIN);
}

export interface MirrorAsset {
  body: string;
  type: string;
}

/** Fetches and rewrites once, then serves from memory for `ttlMs`. */
export class MakeCodeMirror {
  private cache = new Map<string, { at: number; asset: MirrorAsset }>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(name: "editor" | "simulator" | "worker"): Promise<MirrorAsset> {
    const hit = this.cache.get(name);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.asset;
    const asset = await this.load(name);
    this.cache.set(name, { at: this.now(), asset });
    return asset;
  }

  private async load(name: string): Promise<MirrorAsset> {
    const url =
      name === "editor"
        ? `${MAKECODE_ORIGIN}/?controller=2`
        : name === "simulator"
          ? `${SIM_ORIGIN}/---simulator`
          : `${MAKECODE_ORIGIN}/---worker`;
    const done = log.time(`fetch ${name}`);
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`MakeCode ${name} fetch failed: ${res.status}`);
    const text = await res.text();
    done();
    if (name === "editor") return { body: rewriteEditorHtml(text), type: "text/html; charset=utf-8" };
    if (name === "simulator")
      return { body: rewriteSimulatorHtml(text), type: "text/html; charset=utf-8" };
    return { body: text, type: "application/javascript; charset=utf-8" };
  }
}
