import { describe, it, expect, afterEach, vi } from "vitest";

// The widget bridge runs inside a host sandbox without `allow-same-origin`, so
// its document has an opaque origin. There, *reading* the localStorage property
// throws SecurityError rather than returning undefined, which optional chaining
// does not catch. This module reads it at import time, so an unguarded access
// takes down every module that imports the logger.
function opaqueOrigin() {
  vi.stubGlobal("process", { env: {}, versions: {} });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
  vi.resetModules();
});

describe("logger in an opaque origin", () => {
  it("imports without throwing when localStorage access is denied", async () => {
    vi.resetModules();
    opaqueOrigin();
    const mod = await import("../../src/shared/logger.ts");
    expect(() => mod.createLogger("widget-shim").info("hello")).not.toThrow();
  });
});
