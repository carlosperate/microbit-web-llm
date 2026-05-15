import { describe, it, expect } from "vitest";
import {
  encodeBlocksImage,
  decodeBlocksImage,
  encodeHex,
  decodeHex,
  stubImageResult,
  stubHexResult,
  blocksImageMcpContent,
  hexFileMcpPayload,
} from "../../src/shared/tool-results.js";

describe("tool-results codecs", () => {
  it("round-trips blocks-image payload", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const raw = encodeBlocksImage(png);
    expect(JSON.parse(raw)).toEqual({ pngBase64: png });
    expect(decodeBlocksImage(raw)).toBe(png);
  });

  it("decodeBlocksImage returns null for malformed input", () => {
    expect(decodeBlocksImage("")).toBeNull();
    expect(decodeBlocksImage("not json")).toBeNull();
    expect(decodeBlocksImage("{\"foo\":1}")).toBeNull();
    expect(decodeBlocksImage("{\"pngBase64\":\"\"}")).toBeNull();
    expect(decodeBlocksImage("{\"pngBase64\":42}")).toBeNull();
  });

  it("round-trips hex payload (raw base64)", () => {
    const hex = "OmZvb2Jhcg==";
    expect(encodeHex(hex)).toBe(hex);
    expect(decodeHex(encodeHex(hex))).toBe(hex);
    expect(decodeHex("")).toBeNull();
  });

  it("stub helpers include byte length and do not embed payload", () => {
    const imgStub = stubImageResult(21_000);
    expect(imgStub).toContain("21000");
    expect(imgStub).toContain("not shown");
    // The stub remains parseable as the same shape so decode still returns
    // *something*, but it must not be a real base64 image — that's the point.
    const stubPng = decodeBlocksImage(imgStub);
    expect(stubPng).toMatch(/not shown/);

    const hexStub = stubHexResult(1_700_000);
    expect(hexStub).toContain("1700000");
    expect(hexStub).toContain("not shown");
  });

  it("server MCP content helpers shape image and hex payloads", () => {
    const png = "PNGPAYLOAD";
    expect(blocksImageMcpContent(png)).toEqual({
      type: "image",
      data: png,
      mimeType: "image/png",
    });
    const hex = "HEXPAYLOAD";
    expect(hexFileMcpPayload(hex)).toEqual({ hex_base64: hex });
  });
});
