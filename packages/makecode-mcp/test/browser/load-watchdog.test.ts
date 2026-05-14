import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoadWatchdog } from "../../src/browser/load-watchdog.js";

describe("LoadWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onTimeout if notifyReady is not called within the timeout", () => {
    const onTimeout = vi.fn();
    const wd = new LoadWatchdog(30_000, onTimeout);
    wd.start();
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0]).toMatch(/30000/);
  });

  it("does not fire onTimeout if notifyReady is called first", () => {
    const onTimeout = vi.fn();
    const wd = new LoadWatchdog(30_000, onTimeout);
    wd.start();
    vi.advanceTimersByTime(10_000);
    wd.notifyReady();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not fire onTimeout after dispose", () => {
    const onTimeout = vi.fn();
    const wd = new LoadWatchdog(30_000, onTimeout);
    wd.start();
    wd.dispose();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("fires onTimeout at most once", () => {
    const onTimeout = vi.fn();
    const wd = new LoadWatchdog(1_000, onTimeout);
    wd.start();
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    wd.notifyReady();
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent", () => {
    const onTimeout = vi.fn();
    const wd = new LoadWatchdog(1_000, onTimeout);
    wd.start();
    wd.start();
    wd.start();
    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
