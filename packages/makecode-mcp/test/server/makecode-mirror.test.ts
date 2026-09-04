import { describe, it, expect } from "vitest";
import {
  rewriteEditorHtml,
  rewriteSimulatorHtml,
  SIM_URL_PLACEHOLDER,
  WORKER_URL_PLACEHOLDER,
} from "../../src/server/makecode-mirror.ts";

const EDITOR = `<!doctype html><html><head>
<script type="text/javascript">var pxtConfig = {"relprefix":"/---","simUrl":"https://trg-microbit.userpxt.io/---simulator","workerjs":"/---worker"};</script>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<script src="https://cdn.makecode.com/blob/aaa/pxtapp.js"></script>
<script id="mainscript" type="text/javascript" src="https://cdn.makecode.com/blob/bbb/main.js"></script>
</body></html>`;

describe("makecode mirror — editor page", () => {
  it("makes root-relative URLs absolute so a blob document can resolve them", () => {
    const out = rewriteEditorHtml(EDITOR);
    expect(out).toContain('href="https://makecode.microbit.org/static/style.css"');
    expect(out).not.toMatch(/href="\/static/);
  });

  it("forces the controller-mode check to memoize before main.js runs", () => {
    // pxt overwrites location.hash with #editor during startup and only then
    // evaluates isControllerMode(), so the fragment carrying controller=2 is
    // gone by the time it looks. The check memoises on first call.
    const out = rewriteEditorHtml(EDITOR);
    const forced = out.indexOf("isControllerMode");
    const main = out.indexOf('id="mainscript"');
    expect(forced).toBeGreaterThan(-1);
    expect(forced).toBeLessThan(main);
  });

  it("leaves placeholders for the blob URLs the view mints at runtime", () => {
    const out = rewriteEditorHtml(EDITOR);
    expect(out).toContain(SIM_URL_PLACEHOLDER);
    expect(out).toContain(WORKER_URL_PLACEHOLDER);
    // The originals must be gone: a cross-origin worker is refused outright,
    // and the simulator's own origin is not in any host's frame-src.
    expect(out).not.toContain("trg-microbit.userpxt.io/---simulator");
    expect(out).not.toContain('"/---worker"');
  });
});

describe("makecode mirror — refuses to emit a half-rewritten page", () => {
  // A missed reference is silent at build time and fatal at runtime: a
  // cross-origin worker is refused outright and the simulator's own origin is
  // in nobody's frame-src, so the editor hangs with no useful error.
  it("throws when the worker reference is not where it expects", () => {
    const noWorker = EDITOR.replace('"workerjs":"/---worker"', '"workerjs":"/---renamed"');
    expect(() => rewriteEditorHtml(noWorker)).toThrow(/worker/i);
  });

  it("throws when the simulator reference is not where it expects", () => {
    const noSim = EDITOR.replace(
      '"simUrl":"https://trg-microbit.userpxt.io/---simulator"',
      '"simUrl":"https://elsewhere.example/---sim"',
    );
    expect(() => rewriteEditorHtml(noSim)).toThrow(/simulator/i);
  });
});

describe("makecode mirror — simulator page", () => {
  it("makes the simulator's own URLs absolute", () => {
    const out = rewriteSimulatorHtml(
      `<html><head><script src="/sim/pxtsim.js"></script><script src="/---simserviceworker"></script></head></html>`,
    );
    expect(out).toContain('src="https://trg-microbit.userpxt.io/sim/pxtsim.js"');
    expect(out).toContain('src="https://trg-microbit.userpxt.io/---simserviceworker"');
  });
});
