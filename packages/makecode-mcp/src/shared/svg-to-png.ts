// Rasterize an SVG string to a base64-encoded PNG using the browser's
// Image + Canvas APIs. Runs in the iframe-executor (host page) and inside
// the Puppeteer-driven shell page on the server target.
//
// The output is the raw base64 (no `data:image/png;base64,` prefix), ready
// to drop into an MCP `image` content block or an `<img src="data:...">`.

export async function svgToPngBase64(
  svg: string,
  scale: number = 2,
): Promise<string> {
  if (!svg) return "";
  // Encode the SVG as a UTF-8 data URL. Avoids cross-origin canvas taint that
  // some browsers raise on blob: URLs without a same-origin loader.
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load SVG for rasterization"));
    img.src = encoded;
  });
  const w = img.naturalWidth || img.width || 1;
  const h = img.naturalHeight || img.height || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.split(",")[1] ?? "";
}
