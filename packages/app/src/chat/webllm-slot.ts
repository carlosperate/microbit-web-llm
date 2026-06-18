import { useCallback, useRef, useState } from "react";
import {
  loadWebLLM,
  isWebGPUSupported,
  LoadCancelledError,
  type LoadHandle,
  type LoadState,
} from "./webllm-engine.js";
import type { ModelId } from "../config.js";
import type { ChatCompletionFn } from "./tool-loop.js";
import { createLogger } from "makecode-mcp/browser";

const log = createLogger("webllm");

export type WebLLMSlot = {
  completion: ChatCompletionFn | null;
  /** Ref to the completion fn — updated immediately when the model loads, before
   *  React re-renders. Use this in closures that run right after `load()` resolves
   *  (e.g. broadcastSend) to avoid reading a stale snapshot from the last render. */
  completionRef: { readonly current: ChatCompletionFn | null };
  loadState: LoadState;
  loadedModelId: ModelId | null;
  /** Loaded model's context window; `null` until a model is loaded. */
  loadedContextWindow: number | null;
  load: (modelId: ModelId) => Promise<void>;
  cancel: () => void;
};

export function useWebLLMSlot(opts?: { onLoaded?: () => void }): WebLLMSlot {
  const [loadState, setLoadState] = useState<LoadState>(
    isWebGPUSupported()
      ? { status: "idle" }
      : { status: "unsupported", reason: "WebGPU is not available. Please use Chrome 113+ on a supported GPU." },
  );
  const [loadedModelId, setLoadedModelId] = useState<ModelId | null>(null);
  const [loadedContextWindow, setLoadedContextWindow] = useState<number | null>(null);
  const completionRef = useRef<ChatCompletionFn | null>(null);
  const loadHandleRef = useRef<LoadHandle | null>(null);
  const onLoadedRef = useRef(opts?.onLoaded);
  onLoadedRef.current = opts?.onLoaded;

  const load = useCallback(async (modelId: ModelId) => {
    log.info("slot: load requested", { modelId });
    loadHandleRef.current?.cancel();
    setLoadState({ status: "loading", progress: 0, text: "Starting", modelId });
    let handle: LoadHandle | null = null;
    handle = loadWebLLM(
      (r) => {
        if (loadHandleRef.current !== handle) return;
        setLoadState({ status: "loading", progress: r.progress ?? 0, text: r.text, modelId });
      },
      modelId,
    );
    loadHandleRef.current = handle;
    try {
      const { completion, contextWindow } = await handle.promise;
      if (loadHandleRef.current !== handle) return;
      completionRef.current = completion;
      setLoadedModelId(modelId);
      setLoadedContextWindow(contextWindow);
      setLoadState({ status: "ready" });
      onLoadedRef.current?.();
      log.info("slot: model ready", { modelId, contextWindow });
    } catch (err) {
      if (loadHandleRef.current !== handle) return;
      loadHandleRef.current = null;
      if (err instanceof LoadCancelledError) {
        log.info("slot: load cancelled", { modelId });
        completionRef.current = null;
        setLoadedModelId(null);
        setLoadedContextWindow(null);
        setLoadState({ status: "idle" });
        return;
      }
      log.error("slot: load failed", err);
      completionRef.current = null;
      setLoadedModelId(null);
      setLoadedContextWindow(null);
      setLoadState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }, []);

  const cancel = useCallback(() => {
    const handle = loadHandleRef.current;
    if (!handle) return;
    log.info("slot: user cancel");
    loadHandleRef.current = null;
    completionRef.current = null;
    setLoadedModelId(null);
    setLoadedContextWindow(null);
    setLoadState({ status: "idle" });
    handle.cancel();
  }, []);

  return {
    completion: completionRef.current,
    completionRef,
    loadState,
    loadedModelId,
    loadedContextWindow,
    load,
    cancel,
  };
}
