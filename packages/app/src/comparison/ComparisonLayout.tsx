import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { MakeCodePanel } from "makecode-mcp/browser";
import type { BrowserExecutor } from "makecode-mcp/browser";
import { createLogger, preview } from "makecode-mcp/browser";
import { createChatAdapter } from "../chat/adapter.js";
import type { ChatSettings } from "../chat/settings.js";
import { MODELS, type ModelId, PREFAB_PROMPTS } from "../config.js";
import { useWebLLMSlot } from "../chat/webllm-slot.js";
import { ChatPanelView } from "./ChatPanelView.js";

const log = createLogger("comparison");

export const PANEL_INDICES = [0, 1, 2] as const;
export type PanelIndex = (typeof PANEL_INDICES)[number];


export function ComparisonLayout({
  settings,
  settingsOverlay,
}: {
  settings: ChatSettings;
  settingsOverlay?: ReactNode;
}) {
  const [activePanelIndex, setActivePanelIndex] = useState<PanelIndex>(0);
  const [selectedModelIds, setSelectedModelIds] = useState<[ModelId, ModelId, ModelId]>([
    MODELS[0].id,
    MODELS[1].id,
    MODELS[2].id,
  ]);
  const [threadHasMessages, setThreadHasMessages] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const [openerText, setOpenerText] = useState("");
  const [broadcastPending, setBroadcastPending] = useState(false);

  const slot = useWebLLMSlot();

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Refs for stable access in callbacks without stale closures
  const selectedModelIdsRef = useRef(selectedModelIds);
  selectedModelIdsRef.current = selectedModelIds;
  const activePanelIndexRef = useRef(activePanelIndex);
  activePanelIndexRef.current = activePanelIndex;

  // slot.completionRef is the hook's internal ref — updated immediately when the model
  // loads, before React re-renders. Adapters read it directly so broadcastSend can
  // append right after slot.load() without waiting for a re-render to flush the snapshot.
  const slotCompletionRef = slot.completionRef;

  const executorRefs = useRef<[BrowserExecutor | null, BrowserExecutor | null, BrowserExecutor | null]>([
    null, null, null,
  ]);

  // Per-panel ref objects; each ChatPanelView writes its runtime into its slot,
  // and broadcastSend reads from it to append messages programmatically.
  const runtimeRefs = useRef<[
    { current: AssistantRuntime | null },
    { current: AssistantRuntime | null },
    { current: AssistantRuntime | null },
  ]>([{ current: null }, { current: null }, { current: null }]);

  const allThreadsEmpty = threadHasMessages.every((v) => !v);
  const showOpenerBar = allThreadsEmpty && !broadcastPending;

  const adapters = useMemo(
    () =>
      PANEL_INDICES.map((i) =>
        createChatAdapter({
          completion: async (args) => {
            const fn = slotCompletionRef.current;
            if (!fn) throw new Error("No model loaded. Use 'Switch to this model' to activate this panel.");
            return fn(args);
          },
          getExecutor: () => executorRefs.current[i],
          getSettings: () => {
            const s = settingsRef.current;
            return {
              systemPrompt: s.systemPrompt,
              temperature: s.temperature,
              maxTokens: s.maxTokens,
              maxSteps: s.maxSteps,
            };
          },
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const switchActive = useCallback(
    async (index: PanelIndex, overrideModelId?: ModelId) => {
      const modelId = overrideModelId ?? selectedModelIdsRef.current[index];
      log.info("switchActive", { index, modelId });
      setActivePanelIndex(index);
      activePanelIndexRef.current = index;
      await slot.load(modelId);
    },
    [slot.load],
  );

  const handleModelChange = useCallback(
    (panelIndex: PanelIndex, modelId: ModelId) => {
      setSelectedModelIds((prev) => {
        const next = [...prev] as [ModelId, ModelId, ModelId];
        next[panelIndex] = modelId;
        return next;
      });
      // Update ref immediately so switchActive reads the new value on the same tick.
      selectedModelIdsRef.current[panelIndex] = modelId;
      if (panelIndex === activePanelIndexRef.current) {
        void switchActive(panelIndex, modelId);
      }
    },
    [switchActive],
  );

  const handleSwitchActive = useCallback(
    (index: PanelIndex) => {
      void switchActive(index);
    },
    [switchActive],
  );

  const handleExecutorReady = useCallback((panelIndex: PanelIndex, executor: BrowserExecutor) => {
    log.info("executor ready", { panelIndex });
    executorRefs.current[panelIndex] = executor;
  }, []);

  const handleHasMessages = useCallback((index: PanelIndex, hasMessages: boolean) => {
    setThreadHasMessages((prev) => {
      if (prev[index] === hasMessages) return prev;
      const next = [...prev] as [boolean, boolean, boolean];
      next[index] = hasMessages;
      return next;
    });
  }, []);

  const broadcastSend = useCallback(
    async (prompt: string) => {
      log.group("broadcastSend");
      log.info("starting", { prompt: preview(prompt, 80) });
      try {
        for (const i of PANEL_INDICES) {
          const modelId = selectedModelIdsRef.current[i];
          log.info("panel", { index: i, modelId });
          setActivePanelIndex(i);
          activePanelIndexRef.current = i;
          await slot.load(modelId);

          const runtime = runtimeRefs.current[i].current;
          if (!runtime) {
            log.warn("no runtime for panel, skipping", { index: i });
            continue;
          }

          // Register runEnd listener BEFORE appending — the event fires when the
          // adapter's run() generator completes (entire tool loop done), which is
          // the correct "turn finished" signal. Using isRunning subscribe was
          // unreliable: it could briefly be false between tool-call rounds, causing
          // broadcastSend to move on before the model finished generating.
          const turnDone = new Promise<void>((resolve) => {
            const off = runtime.thread.unstable_on("runEnd", () => {
              off();
              resolve();
            });
          });

          runtime.thread.append({
            role: "user",
            content: [{ type: "text", text: prompt }],
            startRun: true,
          });

          log.info("awaiting turn", { index: i });
          await turnDone;
          log.info("turn complete", { index: i });
        }
      } finally {
        log.info("complete");
        log.groupEnd();
      }
    },
    [slot.load],
  );

  const handleOpenerSend = useCallback(() => {
    const text = openerText.trim();
    if (!text) return;
    setOpenerText("");
    setBroadcastPending(true);
    broadcastSend(text).catch((err) => log.error("broadcast failed", err)).finally(() => setBroadcastPending(false));
  }, [openerText, broadcastSend]);

  return (
    <div
      className="comparison-container"
      data-active-panel={activePanelIndex}
    >
      <div className="comparison-chats">
        <div className="comparison-panels-row">
          {PANEL_INDICES.map((i) => (
            <ChatPanelView
              key={i}
              index={i}
              isActive={i === activePanelIndex}
              modelId={selectedModelIds[i]}
              onModelChange={(id) => handleModelChange(i, id)}
              onSwitchActive={() => handleSwitchActive(i)}
              adapter={adapters[i]}
              loadState={i === activePanelIndex ? slot.loadState : undefined}
              runtimeRef={runtimeRefs.current[i]}
              onHasMessages={(v) => handleHasMessages(i, v)}
              hideComposer={showOpenerBar}
            />
          ))}
        </div>
        {showOpenerBar && (
          <div className="comparison-opener-bar">
            <div className="comparison-opener-prefab-row">
              <select
                className="comparison-opener-prefab"
                value=""
                onChange={(e) => { if (e.target.value) setOpenerText(e.target.value); }}
              >
                <option value="">Prefab prompts…</option>
                {PREFAB_PROMPTS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="comparison-opener-inner">
              <textarea
                className="composer-input"
                placeholder="Send a prompt to all three models…"
                value={openerText}
                onChange={(e) => setOpenerText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleOpenerSend(); } }}
                rows={1}
              />
              <button
                type="button"
                className="comparison-send-all-btn"
                disabled={!openerText.trim()}
                onClick={handleOpenerSend}
                data-testid="send-to-all"
              >
                Send to all
              </button>
            </div>
          </div>
        )}
        {settingsOverlay}
      </div>
      <div className="comparison-makecode-slot">
        {PANEL_INDICES.map((i) => (
          <div
            key={i}
            className={`comparison-makecode-wrapper${i === activePanelIndex ? " is-visible" : ""}`}
            data-active={i === activePanelIndex}
          >
            <MakeCodePanel
              onExecutorReady={(executor) => handleExecutorReady(i, executor)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
