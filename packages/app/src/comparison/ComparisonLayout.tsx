import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { MakeCodePanel } from "makecode-mcp/browser";
import type { BrowserExecutor } from "makecode-mcp/browser";
import { createLogger } from "makecode-mcp/browser";
import { createChatAdapter } from "../chat/adapter.js";
import type { ChatSettings } from "../chat/settings.js";
import { MODELS, type ModelId } from "../chat/webllm-engine.js";
import { ChatPanelView } from "./ChatPanelView.js";

const log = createLogger("comparison");

export const PANEL_INDICES = [0, 1, 2] as const;
export const PANEL_COUNT = PANEL_INDICES.length;
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

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const executorRefs = useRef<[BrowserExecutor | null, BrowserExecutor | null, BrowserExecutor | null]>([
    null, null, null,
  ]);

  const adapters = useMemo(
    () =>
      PANEL_INDICES.map((i) =>
        createChatAdapter({
          completion: async () => {
            throw new Error("No model loaded. Use 'Switch to this model' to load a model for this panel.");
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

  const handleModelChange = useCallback((panelIndex: PanelIndex, modelId: ModelId) => {
    setSelectedModelIds((prev) => {
      const next = [...prev] as [ModelId, ModelId, ModelId];
      next[panelIndex] = modelId;
      return next;
    });
  }, []);

  const handleSwitchActive = useCallback((index: PanelIndex) => {
    log.info("switching active panel", { index });
    setActivePanelIndex(index);
  }, []);

  const handleExecutorReady = useCallback((panelIndex: PanelIndex, executor: BrowserExecutor) => {
    log.info("executor ready", { panelIndex });
    executorRefs.current[panelIndex] = executor;
  }, []);

  return (
    <div
      className="comparison-container"
      data-active-panel={activePanelIndex}
    >
      <div className="comparison-chats">
        {PANEL_INDICES.map((i) => (
          <ChatPanelView
            key={i}
            index={i}
            isActive={i === activePanelIndex}
            modelId={selectedModelIds[i]}
            onModelChange={(id) => handleModelChange(i, id)}
            onSwitchActive={() => handleSwitchActive(i)}
            adapter={adapters[i]}
          />
        ))}
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
