import { describe, it, expect, vi } from "vitest";
import { SessionStore } from "../../src/server/session-store.ts";

function makeStore(startMs = 1_000_000) {
  let nowMs = startMs;
  const store = new SessionStore({ now: () => nowMs });
  return { store, advance: (ms: number) => (nowMs += ms), at: () => nowMs };
}

describe("SessionStore — records", () => {
  it("create returns a record stamped with the clock, version 0 and the seed files", () => {
    const { store, at } = makeStore();
    const rec = store.create("s1", {
      label: "demo",
      files: { "main.ts": "", "pxt.json": "{}" },
    });
    expect(rec.id).toBe("s1");
    expect(rec.label).toBe("demo");
    expect(rec.version).toBe(0);
    expect(rec.createdAt).toBe(at());
    expect(rec.lastUsedAt).toBe(at());
    expect(rec.files).toEqual({ "main.ts": "", "pxt.json": "{}" });
    expect(store.has("s1")).toBe(true);
    expect(store.size).toBe(1);
  });

  it("create without options yields an empty file map", () => {
    const { store } = makeStore();
    expect(store.create("s1").files).toEqual({});
  });

  it("get returns undefined for an unknown id", () => {
    const { store } = makeStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.has("nope")).toBe(false);
  });

  it("commit replaces the files, bumps the version and refreshes lastUsedAt", () => {
    const { store, advance, at } = makeStore();
    store.create("s1", { files: { "main.ts": "", "README.md": " " } });
    advance(5_000);
    const rec = store.commit("s1", { "main.ts": "basic.showNumber(1)" });
    expect(rec.version).toBe(1);
    expect(rec.lastUsedAt).toBe(at());
    // Replace, don't merge: the editor's save is the whole project.
    expect(rec.files).toEqual({ "main.ts": "basic.showNumber(1)" });
    expect(store.get("s1")!.version).toBe(1);
    expect(store.commit("s1", { "main.ts": "x" }).version).toBe(2);
  });

  it("commit on an unknown id throws", () => {
    const { store } = makeStore();
    expect(() => store.commit("nope", { "main.ts": "x" })).toThrow(/nope/);
  });

  it("get hands back a snapshot — mutating it cannot corrupt the store", () => {
    const { store } = makeStore();
    store.create("s1", { files: { "main.ts": "a" } });
    const snapshot = store.get("s1")!;
    (snapshot.files as Record<string, string>)["main.ts"] = "hacked";
    expect(store.get("s1")!.files["main.ts"]).toBe("a");
  });

  it("sessions are isolated — a commit to one leaves the other untouched", () => {
    const { store } = makeStore();
    store.create("a", { files: { "main.ts": "A" } });
    store.create("b", { files: { "main.ts": "B" } });
    store.commit("a", { "main.ts": "A2" });
    expect(store.get("a")!.files["main.ts"]).toBe("A2");
    expect(store.get("b")!.files["main.ts"]).toBe("B");
    expect(store.get("b")!.version).toBe(0);
  });

  it("delete removes the record and reports whether it existed", () => {
    const { store } = makeStore();
    store.create("s1");
    expect(store.delete("s1")).toBe(true);
    expect(store.delete("s1")).toBe(false);
    expect(store.get("s1")).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("SessionStore — idle tracking", () => {
  it("touch refreshes lastUsedAt without bumping the version", () => {
    const { store, advance, at } = makeStore();
    store.create("s1");
    advance(60_000);
    store.touch("s1");
    expect(store.get("s1")!.lastUsedAt).toBe(at());
    expect(store.get("s1")!.version).toBe(0);
  });

  it("touch on an unknown id is a no-op", () => {
    const { store } = makeStore();
    expect(() => store.touch("nope")).not.toThrow();
  });

  it("staleIds lists only sessions idle for longer than the cutoff", () => {
    const { store, advance } = makeStore();
    store.create("old");
    advance(20 * 60_000);
    store.create("new");
    advance(15 * 60_000); // old: 35 min idle, new: 15 min idle
    expect(store.staleIds(30 * 60_000)).toEqual(["old"]);
    expect(store.staleIds(10 * 60_000).sort()).toEqual(["new", "old"]);
    expect(store.staleIds(60 * 60_000)).toEqual([]);
  });

  it("a commit resets the idle clock", () => {
    const { store, advance } = makeStore();
    store.create("s1");
    advance(29 * 60_000);
    store.commit("s1", { "main.ts": "x" });
    advance(29 * 60_000);
    expect(store.staleIds(30 * 60_000)).toEqual([]);
  });
});

describe("SessionStore — change notifications", () => {
  // Phase 2 attaches widget views here: a view subscribes and pushes the new
  // project into its editor. Nothing consumes it on the server today.
  it("notifies subscribers on create, commit and delete", () => {
    const { store } = makeStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.create("s1", { files: { "main.ts": "" } });
    store.commit("s1", { "main.ts": "x" });
    store.delete("s1");
    expect(seen).toHaveBeenCalledTimes(3);
    expect(seen.mock.calls[0][0]).toMatchObject({ type: "created", sessionId: "s1" });
    expect(seen.mock.calls[1][0]).toMatchObject({ type: "committed", sessionId: "s1" });
    expect(seen.mock.calls[1][0].record.files).toEqual({ "main.ts": "x" });
    expect(seen.mock.calls[2][0]).toMatchObject({ type: "removed", sessionId: "s1" });
  });

  it("deleting an unknown id notifies nobody", () => {
    const { store } = makeStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.delete("nope");
    expect(seen).not.toHaveBeenCalled();
  });

  it("subscribe returns an unsubscribe handle", () => {
    const { store } = makeStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.create("s1");
    off();
    store.commit("s1", { "main.ts": "x" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber cannot break the store or starve the others", () => {
    const { store } = makeStore();
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    store.subscribe(good);
    expect(() => store.create("s1")).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});
