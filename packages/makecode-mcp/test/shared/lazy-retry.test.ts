import { describe, it, expect, vi } from "vitest";
import { lazyRetry } from "../../src/shared/lazy-retry.ts";

describe("lazyRetry", () => {
  it("runs the init once on success and caches the resolved value for future calls", async () => {
    const init = vi.fn(async () => "value");
    const get = lazyRetry(init);

    await expect(get()).resolves.toBe("value");
    await expect(get()).resolves.toBe("value");
    await expect(get()).resolves.toBe("value");
    expect(init).toHaveBeenCalledOnce();
  });

  it("concurrent calls during an in-flight init share the same Promise — no double-run", async () => {
    let release!: (v: string) => void;
    const inflight = new Promise<string>((r) => {
      release = r;
    });
    const init = vi.fn(async () => inflight);
    const get = lazyRetry(init);

    const a = get();
    const b = get();
    const c = get();
    expect(init).toHaveBeenCalledOnce();
    release("ok");
    await expect(Promise.all([a, b, c])).resolves.toEqual(["ok", "ok", "ok"]);
  });

  it("clears the cache on failure so the next call retries the init from scratch", async () => {
    // Regression guard: without this, a transient failure during the first
    // call (network blip, makecode iframe not yet ready, etc.) would wedge
    // every subsequent caller against the same rejected promise forever.
    const init = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");
    const get = lazyRetry(init);

    await expect(get()).rejects.toThrow(/transient/);
    await expect(get()).resolves.toBe("recovered");
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("a later success replaces the rejected cache so further calls don't re-run", async () => {
    const init = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("steady");
    const get = lazyRetry(init);

    await expect(get()).rejects.toThrow(/boom/);
    await expect(get()).resolves.toBe("steady");
    await expect(get()).resolves.toBe("steady");
    await expect(get()).resolves.toBe("steady");
    // Two init runs: one failed, one succeeded; success cached thereafter.
    expect(init).toHaveBeenCalledTimes(2);
  });
});
