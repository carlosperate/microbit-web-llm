/**
 * Centralised codecs for tool-call results. Two formats are in play:
 *
 * 1. **Tool-loop string format** (browser target / WebLLM tool-call exchange)
 *    — what a tool returns to the loop as `result: string`. The model sees
 *    these strings flattened back into chat history.
 * 2. **MCP server content blocks** (server target) — `{type, data, mimeType}`
 *    for image, `{hex_base64}` JSON for hex.
 *
 * Both formats are produced here so the executor, MCP wrapper, and history
 * flattener cannot disagree on the wire shape.
 */

// ─── Tool-loop string format ───────────────────────────────────────────────

/** Encode a PNG (base64) as the tool-loop result string. */
export function encodeBlocksImage(pngBase64: string): string {
  return JSON.stringify({ pngBase64 });
}

/** Parse a tool-loop blocks-image result back to its pngBase64 payload, or
 *  null if the string is not a well-formed image result. Also returns the
 *  raw string for stubbed results, which contain a placeholder rather than
 *  real bytes — distinguishable by content if the caller needs to. */
export function decodeBlocksImage(raw: string): string | null {
  if (!raw || raw[0] !== "{") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const png = (parsed as { pngBase64?: unknown }).pngBase64;
      return typeof png === "string" && png.length > 0 ? png : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Encode a hex file (base64) as the tool-loop result string. The browser
 *  executor returns the raw base64 with no JSON wrapper; this helper exists
 *  to make the intent explicit at call sites and to anchor the format for
 *  future evolution. */
export function encodeHex(hexBase64: string): string {
  return hexBase64;
}

export function decodeHex(raw: string): string | null {
  return raw && raw.length > 0 ? raw : null;
}

// ─── Stubbed forms for flattened tool history ──────────────────────────────
// Image (~21KB) and hex (~1.7MB) base64 are useless to the model and the hex
// blows WebLLM's tokenizer stack — substitute a short placeholder.

export function stubImageResult(byteLen: number): string {
  return `{"pngBase64":"<image rendered, ${byteLen} bytes — not shown>"}`;
}

export function stubHexResult(byteLen: number): string {
  return `<hex compiled, ${byteLen} bytes — not shown>`;
}

// ─── MCP server content shapes ─────────────────────────────────────────────

export interface BlocksImageMcpContent {
  type: "image";
  data: string;
  mimeType: "image/png";
}

export function blocksImageMcpContent(pngBase64: string): BlocksImageMcpContent {
  return { type: "image", data: pngBase64, mimeType: "image/png" };
}

export interface HexFileMcpPayload {
  hex_base64: string;
}

export function hexFileMcpPayload(hexBase64: string): HexFileMcpPayload {
  return { hex_base64: hexBase64 };
}
