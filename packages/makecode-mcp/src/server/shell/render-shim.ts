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

window.__mkcp_render = {
  async renderBlocksImage(code) {
    const renderer = await getRenderer();
    const result = await renderer.renderBlocks({ code });
    const svg = result.svg ?? "";
    if (!svg) return "";
    return svgToPngBase64(svg);
  },
};
