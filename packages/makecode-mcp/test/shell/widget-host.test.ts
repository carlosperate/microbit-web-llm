import { describe, it, expect } from "vitest";
import { findSessionId, sizeMessage } from "../../src/shell/widget-host.ts";

describe("finding the session id in a tool result", () => {
  it("reads it from a JSON text content block", () => {
    // How every host we've seen actually delivers it.
    expect(
      findSessionId({
        content: [{ type: "text", text: JSON.stringify({ session_id: "abc-123" }) }],
      }),
    ).toBe("abc-123");
  });

  it("finds a plain session_id anywhere in the envelope", () => {
    expect(findSessionId({ result: { nested: [{ session_id: "deep" }] } })).toBe("deep");
  });

  it("ignores text blocks that are not JSON", () => {
    expect(findSessionId({ content: [{ type: "text", text: "not json {" }] })).toBeNull();
  });

  it("returns null when there is no session", () => {
    expect(findSessionId({ content: [{ type: "image", data: "..." }] })).toBeNull();
    expect(findSessionId(null)).toBeNull();
    expect(findSessionId("string")).toBeNull();
  });

  it("ignores an empty session_id rather than starting on it", () => {
    expect(findSessionId({ session_id: "" })).toBeNull();
  });
});

describe("asking the host for room", () => {
  it("sends a size-changed notification the host can act on", () => {
    // Hosts start a widget short. An editor needs real height, so it has to
    // ask; without this the MakeCode editor renders in a sliver.
    expect(sizeMessage(900, 720)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 900, height: 720 },
    });
  });

  it("rounds up, since hosts expect whole pixels", () => {
    expect(sizeMessage(799.2, 719.4).params).toEqual({ width: 800, height: 720 });
  });
});
