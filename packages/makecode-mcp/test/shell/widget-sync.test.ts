import { describe, it, expect, vi } from "vitest";
import { ProjectSync, type ProjectSyncOptions } from "../../src/shell/widget-sync.ts";

function makeSync(overrides: Partial<ProjectSyncOptions> = {}) {
  const apply = vi.fn(async (_files: Record<string, string>) => {});
  const save = vi.fn(async (_files: Record<string, string>, _base: number) => 1);
  const onSessionGone = vi.fn();
  const onError = vi.fn();
  const sync = new ProjectSync({ apply, save, onSessionGone, onError, ...overrides });
  return { sync, apply, save, onSessionGone, onError };
}

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("ProjectSync — receiving projects", () => {
  it("imports the first project like any other", async () => {
    // Hydrating through the editor's own initialProjects hook looks cheaper,
    // but that path doesn't decompile: MakeCode would render the stored
    // main.blocks and regenerate main.ts from it, emptying the session's code.
    const { sync, apply } = makeSync();
    sync.receive({ type: "project", version: 3, files: { "main.ts": "hello" } });
    await tick();
    expect(apply).toHaveBeenCalledWith({ "main.ts": "hello" });
    expect(sync.version).toBe(3);
  });

  it("applies later projects to the live editor", async () => {
    const { sync, apply } = makeSync();
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b" } });
    await tick();
    expect(apply).toHaveBeenLastCalledWith({ "main.ts": "b" });
    expect(sync.version).toBe(2);
  });

  it("reports session-gone to the page", () => {
    const { sync, onSessionGone } = makeSync();
    sync.receive({ type: "session-gone" });
    expect(onSessionGone).toHaveBeenCalledOnce();
  });
});

describe("ProjectSync — user edits", () => {
  it("sends a changed project up with the version it was based on", async () => {
    const { sync, save } = makeSync();
    sync.receive({ type: "project", version: 4, files: { "main.ts": "a" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "a", "main.blocks": "<moved/>" });
    await tick();
    expect(save).toHaveBeenCalledWith({ "main.ts": "a", "main.blocks": "<moved/>" }, 4);
  });

  it("ignores a save that matches what the server already has", async () => {
    // MakeCode keeps saving after an import; those are echoes, not edits.
    const { sync, save } = makeSync();
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "a" });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores saves emitted while a server project is being applied", async () => {
    // Mid-import the editor briefly holds a half-built project (blocks not
    // decompiled yet); sending that up would overwrite good state with junk.
    let finishApply!: () => void;
    const apply = vi.fn(() => new Promise<void>((r) => (finishApply = r)));
    const { sync, save } = makeSync({ apply });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "b", "main.blocks": "" });
    await tick();
    expect(save).not.toHaveBeenCalled();
    finishApply();
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("reconciles the editor after an apply, so nothing is silently swallowed", async () => {
    // Saves are ignored while importing, and MakeCode emits its decompiled
    // project during that window. Without a read-back the store would never
    // learn what the editor actually ended up with, and an edit made mid-import
    // would be lost.
    // Editor double that decompiles on import, like MakeCode does.
    let editor: Record<string, string> = {};
    const apply = vi.fn(async (files: Record<string, string>) => {
      editor = { ...files, "main.blocks": `<decompiled>${files["main.ts"]}</decompiled>` };
    });
    const readEditor = vi.fn(async () => editor);
    const { sync, save } = makeSync({ apply, readEditor });
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b" } });
    await tick();
    await tick();
    expect(save).toHaveBeenCalledWith(
      { "main.ts": "b", "main.blocks": "<decompiled>b</decompiled>" },
      2,
    );
  });

  it("stays quiet when the editor matches what was applied", async () => {
    let editor: Record<string, string> = {};
    const apply = vi.fn(async (files: Record<string, string>) => {
      editor = { ...files };
    });
    const readEditor = vi.fn(async () => editor);
    const { sync, save } = makeSync({ apply, readEditor });
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b" } });
    await tick();
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses to report a read-back that emptied the code", async () => {
    // An import that ends with no code is a failed import, not an edit.
    // Reporting it would push the empty project up and destroy the session's
    // code, turning a display glitch into data loss.
    const apply = vi.fn(async () => {});
    const readEditor = vi.fn(async () => ({ "main.ts": "\n" }));
    const { sync, save, onError } = makeSync({ apply, readEditor });
    sync.receive({ type: "project", version: 2, files: { "main.ts": "basic.showNumber(7)" } });
    await tick();
    await tick();
    expect(save).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("still reports edits made after an apply finishes", async () => {
    const { sync, save } = makeSync();
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "b edited" });
    await tick();
    expect(save).toHaveBeenCalledWith({ "main.ts": "b edited" }, 2);
  });

  it("coalesces a burst of saves into the newest one", async () => {
    // Dragging a block fires autosaves faster than a round trip.
    let release!: (v: number) => void;
    const save = vi.fn(() => new Promise<number>((r) => (release = r)));
    const { sync } = makeSync({ save });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "b" });
    await tick();
    sync.workspaceSaved({ "main.ts": "c" });
    sync.workspaceSaved({ "main.ts": "d" });
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    release(2);
    await tick();
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual([{ "main.ts": "d" }, 2]);
  });

  it("tracks the version the server assigned to our own save", async () => {
    const { sync, save } = makeSync();
    save.mockResolvedValueOnce(9);
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "b" });
    await tick();
    expect(sync.version).toBe(9);
  });

  it("a failed save is reported and does not wedge later ones", async () => {
    const { sync, save, onError } = makeSync();
    save.mockRejectedValueOnce(new Error("session gone"));
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a" } });
    await tick();
    sync.workspaceSaved({ "main.ts": "b" });
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledOnce();
    sync.workspaceSaved({ "main.ts": "c" });
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("ignores saves that arrive before the first project", async () => {
    // Nothing to base them on, and the editor is still showing its bootstrap
    // project rather than the session's.
    const { sync, save } = makeSync();
    sync.workspaceSaved({ "main.ts": "bootstrap" });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("ProjectSync — a failed import must not rewrite the server", () => {
  it("does not report the old editor contents when the import fails", async () => {
    // The editor still holds the previous project. Reconciling after a failed
    // import would push that back up and undo the write the model just made.
    const saved: Record<string, string>[] = [];
    const sync = new ProjectSync({
      apply: async () => {
        throw new Error("switchBlocks rejected");
      },
      readEditor: async () => ({ "main.ts": "old code\n" }),
      save: async (files) => {
        saved.push(files);
        return 2;
      },
    });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "new code\n" } });
    await tick(4);
    expect(saved).toEqual([]);
  });

  it("still reconciles when the import succeeds", async () => {
    const saved: Record<string, string>[] = [];
    const sync = new ProjectSync({
      apply: async () => {},
      // MakeCode rewrites what it imported, and the server has to learn that.
      readEditor: async () => ({ "main.ts": "new code\n", "main.blocks": "<xml/>" }),
      save: async (files) => {
        saved.push(files);
        return 2;
      },
    });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "new code\n" } });
    await tick(4);
    expect(saved).toHaveLength(1);
    expect(saved[0]!["main.blocks"]).toBe("<xml/>");
  });
});

describe("ProjectSync — overlapping remote updates", () => {
  it("applies them one at a time, newest last", async () => {
    // session_start hands the view an empty project and session_set_code
    // follows immediately; both imports would otherwise race on one editor.
    const order: string[] = [];
    let inFlight = 0;
    const sync = new ProjectSync({
      apply: async (files) => {
        if (inFlight > 0) throw new Error("concurrent apply");
        inFlight++;
        await tick(2);
        order.push(files["main.ts"] ?? "");
        inFlight--;
      },
      readEditor: async () => ({ "main.ts": order.at(-1) ?? "" }),
      save: async () => 9,
    });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "first\n" } });
    sync.receive({ type: "project", version: 2, files: { "main.ts": "second\n" } });
    await tick(12);
    expect(order.at(-1)).toBe("second\n");
  });

  it("drops a superseded update rather than applying it after a newer one", async () => {
    const applied: string[] = [];
    const sync = new ProjectSync({
      apply: async (files) => {
        await tick(2);
        applied.push(files["main.ts"] ?? "");
      },
      save: async () => 9,
    });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "a\n" } });
    sync.receive({ type: "project", version: 2, files: { "main.ts": "b\n" } });
    sync.receive({ type: "project", version: 3, files: { "main.ts": "c\n" } });
    await tick(12);
    // Whatever the timing, a superseded version must never reach the editor and
    // the newest must be what lands last.
    expect(applied).not.toContain("b\n");
    expect(applied.at(-1)).toBe("c\n");
  });
});

describe("ProjectSync — the apply chain survives a rejection", () => {
  it("keeps delivering later projects after one apply throws", async () => {
    // A poisoned chain fails silently: every subsequent project is dropped and
    // the editor quietly stops tracking the session.
    const applied: string[] = [];
    let failNext = true;
    const sync = new ProjectSync({
      apply: async (files) => {
        if (failNext) {
          failNext = false;
          throw new Error("import blew up");
        }
        applied.push(files["main.ts"] ?? "");
      },
      save: async () => 7,
    });
    sync.receive({ type: "project", version: 1, files: { "main.ts": "first\n" } });
    await tick(6);
    sync.receive({ type: "project", version: 2, files: { "main.ts": "second\n" } });
    await tick(6);
    expect(applied).toEqual(["second\n"]);
  });
});
