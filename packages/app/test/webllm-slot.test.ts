import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadWebLLM, type LoadHandle } from "../src/chat/webllm-engine.js";
// Value import from the new module — fails (module not found) until webllm-slot.ts is created.
import { useWebLLMSlot } from "../src/chat/webllm-slot.js";

void useWebLLMSlot; // prevent tree-shaking from eliminating the import

const { mockUnload, MockMLCEngine } = vi.hoisted(() => {
  const mockUnload = vi.fn().mockResolvedValue(undefined);
  const MockMLCEngine = vi.fn().mockImplementation(
    ({ initProgressCallback: _cb }: { initProgressCallback: (r: unknown) => void }) => ({
      reload: vi.fn().mockResolvedValue(undefined),
      unload: mockUnload,
      chat: { completions: { create: vi.fn() } },
    }),
  );
  return { mockUnload, MockMLCEngine };
});

vi.mock("@mlc-ai/web-llm", () => ({ MLCEngine: MockMLCEngine }));

describe("useWebLLMSlot load sequence", () => {
  let originalNavigator: typeof globalThis.navigator;

  beforeEach(() => {
    mockUnload.mockClear();
    MockMLCEngine.mockClear();
    originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: {} },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("load(modelA) then load(modelB) invokes engine.unload() once before B starts", async () => {
    // Verifies the sequential-load contract that useWebLLMSlot.load() must implement:
    // call cancel() on the prior handle before starting a new load, so the prior
    // engine's GPU buffers are freed (cancel() calls engine.unload() per commit-1 fix).
    let priorHandle: LoadHandle | null = null;

    async function slotLoad(modelId: string) {
      priorHandle?.cancel(); // ← the contract: cancel prior before starting next
      const h = loadWebLLM(vi.fn(), modelId);
      priorHandle = h;
      await h.promise;
    }

    await slotLoad("model-a");
    expect(mockUnload).not.toHaveBeenCalled(); // loaded, not yet unloaded

    await slotLoad("model-b"); // must cancel/unload model-a first
    expect(mockUnload).toHaveBeenCalledTimes(1);
  });
});
