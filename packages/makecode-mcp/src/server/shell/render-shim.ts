import { createMakeCodeRenderBlocks } from "@microbit/makecode-embed/vanilla";
import { svgToPngBase64 } from "../../shared/svg-to-png.js";

interface RenderApi {
  renderBlocksImage(code: string): Promise<string>;
}

declare global {
  interface Window {
    __mkcp_render: RenderApi;
  }
}

let rendererPromise: Promise<ReturnType<typeof createMakeCodeRenderBlocks>> | null = null;

function getRenderer() {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const r = createMakeCodeRenderBlocks({});
      r.initialize();
      return r;
    })();
  }
  return rendererPromise;
}

// Eagerly start renderer iframe load as soon as the render shell page opens.
// makecode-embed enforces a hardcoded 30s `renderready` timeout from the
// moment `initialize()` is called; starting at page load (rather than at
// first tool call) gives slow connections the maximum chance to finish.
getRenderer();

window.__mkcp_render = {
  async renderBlocksImage(code) {
    const renderer = await getRenderer();
    const result = await renderer.renderBlocks({ code });
    const svg = result.svg ?? "";
    if (!svg) return "";
    // scale=1 (vs the browser-target default of 2) — the MCP transport sends
    // the PNG as base64 to the LLM, where a 2× retina image is wasted bytes.
    return svgToPngBase64(svg, 1);
  },
};
