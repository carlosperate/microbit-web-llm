import { describe, it, expect, vi } from "vitest";
import { buildMakeCodeBlobUrl } from "../../src/shell/makecode-blob.ts";
import {
  SIM_URL_PLACEHOLDER,
  WORKER_URL_PLACEHOLDER,
} from "../../src/server/makecode-mirror.ts";

function harness(editorHtml: string) {
  const made: { text: string; type: string }[] = [];
  const assets: Record<string, string> = {
    "/mk/editor.html": editorHtml,
    "/mk/simulator.html": "<html>sim</html>",
    "/mk/worker.js": "self.onmessage=()=>{}",
  };
  return {
    made,
    deps: {
      fetchText: vi.fn(async (path: string) => assets[path] ?? ""),
      createObjectURL: vi.fn((text: string, type: string) => {
        made.push({ text, type });
        return `blob:fake/${made.length}`;
      }),
    },
  };
}

describe("booting MakeCode from a blob", () => {
  it("substitutes the simulator and worker with blob URLs it minted first", async () => {
    const h = harness(`<html>sim=${SIM_URL_PLACEHOLDER} worker=${WORKER_URL_PLACEHOLDER}</html>`);
    await buildMakeCodeBlobUrl(h.deps);
    const editorDoc = h.made.at(-1)!.text;
    expect(editorDoc).not.toContain(SIM_URL_PLACEHOLDER);
    expect(editorDoc).not.toContain(WORKER_URL_PLACEHOLDER);
    expect(editorDoc).toMatch(/sim=blob:fake\/\d/);
    expect(editorDoc).toMatch(/worker=blob:fake\/\d/);
  });

  it("carries controller=2 in the fragment, since a blob URL has no query", async () => {
    const h = harness("<html>x</html>");
    const url = await buildMakeCodeBlobUrl(h.deps);
    expect(url).toMatch(/^blob:fake\/\d+#controller=2$/);
  });

  it("serves the editor document as html so the iframe renders it", async () => {
    const h = harness("<html>x</html>");
    await buildMakeCodeBlobUrl(h.deps);
    expect(h.made.at(-1)!.type).toBe("text/html");
  });
});
