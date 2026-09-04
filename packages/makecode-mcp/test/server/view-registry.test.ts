import { describe, it, expect, vi } from "vitest";
import { ViewRegistry } from "../../src/server/view-registry.ts";
import type { SessionView } from "../../src/server/view-registry.ts";

function makeView(id: string, sessionId: string) {
  const sent: unknown[] = [];
  const view: SessionView = {
    id,
    sessionId,
    send: vi.fn((msg) => sent.push(msg)),
    close: vi.fn(),
  };
  return { view, sent };
}

describe("ViewRegistry", () => {
  it("broadcasts to every view attached to that session only", () => {
    const reg = new ViewRegistry();
    const a1 = makeView("a1", "s1");
    const a2 = makeView("a2", "s1");
    const b1 = makeView("b1", "s2");
    reg.attach(a1.view);
    reg.attach(a2.view);
    reg.attach(b1.view);

    reg.broadcast("s1", { type: "project", version: 1, files: {} });

    expect(a1.sent).toHaveLength(1);
    expect(a2.sent).toHaveLength(1);
    expect(b1.sent).toHaveLength(0);
  });

  it("skips the view a change came from", () => {
    const reg = new ViewRegistry();
    const a = makeView("a", "s1");
    const b = makeView("b", "s1");
    reg.attach(a.view);
    reg.attach(b.view);

    reg.broadcast("s1", { type: "project", version: 2, files: {} }, { except: "a" });

    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  it("attach returns a detach handle that stops delivery", () => {
    const reg = new ViewRegistry();
    const a = makeView("a", "s1");
    const detach = reg.attach(a.view);
    detach();
    reg.broadcast("s1", { type: "project", version: 1, files: {} });
    expect(a.sent).toHaveLength(0);
    expect(reg.countFor("s1")).toBe(0);
  });

  it("detaching twice is harmless and cannot evict a later view with the same id", () => {
    // A reconnecting widget reuses its view id; a late detach from the old
    // connection must not unhook the new one.
    const reg = new ViewRegistry();
    const first = makeView("a", "s1");
    const detachFirst = reg.attach(first.view);
    detachFirst();
    const second = makeView("a", "s1");
    reg.attach(second.view);
    detachFirst();
    reg.broadcast("s1", { type: "project", version: 1, files: {} });
    expect(second.sent).toHaveLength(1);
  });

  it("broadcasting to a session with no views is a no-op", () => {
    const reg = new ViewRegistry();
    expect(() =>
      reg.broadcast("nobody", { type: "project", version: 1, files: {} }),
    ).not.toThrow();
  });

  it("a throwing view cannot starve the others", () => {
    const reg = new ViewRegistry();
    const bad = makeView("bad", "s1");
    (bad.view.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("socket gone");
    });
    const good = makeView("good", "s1");
    reg.attach(bad.view);
    reg.attach(good.view);

    reg.broadcast("s1", { type: "project", version: 1, files: {} });

    expect(good.sent).toHaveLength(1);
  });

  it("closeAll closes and forgets a session's views", () => {
    const reg = new ViewRegistry();
    const a = makeView("a", "s1");
    const b = makeView("b", "s1");
    reg.attach(a.view);
    reg.attach(b.view);

    reg.closeAll("s1");

    expect(a.view.close).toHaveBeenCalledOnce();
    expect(b.view.close).toHaveBeenCalledOnce();
    expect(reg.countFor("s1")).toBe(0);
  });

  it("closeEverything drops every session (server shutdown)", () => {
    const reg = new ViewRegistry();
    const a = makeView("a", "s1");
    const b = makeView("b", "s2");
    reg.attach(a.view);
    reg.attach(b.view);

    reg.closeEverything();

    expect(a.view.close).toHaveBeenCalledOnce();
    expect(b.view.close).toHaveBeenCalledOnce();
    expect(reg.countFor("s1")).toBe(0);
    expect(reg.countFor("s2")).toBe(0);
  });
});
