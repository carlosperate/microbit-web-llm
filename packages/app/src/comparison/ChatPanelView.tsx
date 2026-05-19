import { AssistantRuntimeProvider, type ChatModelAdapter, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "../chat/Thread.js";
import { MODELS, type LoadState, type ModelId } from "../chat/webllm-engine.js";
import type { PanelIndex } from "./ComparisonLayout.js";

export interface ChatPanelViewProps {
  index: PanelIndex;
  isActive: boolean;
  modelId: ModelId;
  onModelChange: (modelId: ModelId) => void;
  onSwitchActive: () => void;
  adapter: ChatModelAdapter;
  loadState?: LoadState;
}

export function ChatPanelView({
  index,
  isActive,
  modelId,
  onModelChange,
  onSwitchActive,
  adapter,
  loadState,
}: ChatPanelViewProps) {
  const runtime = useLocalRuntime(adapter);
  const selectedModel = MODELS.find((m) => m.id === modelId);
  const isLoading = isActive && loadState?.status === "loading";
  const loadProgress = loadState?.status === "loading" ? Math.round((loadState.progress ?? 0) * 100) : 0;

  const inactiveComposer = (
    <div className="comparison-inactive-footer">
      <button
        type="button"
        className="comparison-switch-btn"
        onClick={onSwitchActive}
        data-testid={`switch-active-${index}`}
      >
        Switch to this model
      </button>
    </div>
  );

  return (
    <div
      className="chat-panel-view"
      data-panel-index={index}
      data-active={isActive}
    >
      <header className="chat-header comparison-panel-header" data-active={isActive}>
        <div className="comparison-panel-title">
          {selectedModel?.shortLabel ?? modelId}
        </div>
        <select
          className="comparison-model-select"
          value={modelId}
          onChange={(e) => onModelChange(e.target.value as ModelId)}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.shortLabel}</option>
          ))}
        </select>
      </header>
      <div className="chat-body">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread composerSlot={isActive ? undefined : inactiveComposer} />
        </AssistantRuntimeProvider>
        {isLoading && (
          <div className="model-gate-overlay" data-testid="comparison-load-overlay">
            <div className="model-gate-card">
              <h3>Loading {selectedModel?.label ?? modelId}…</h3>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${loadProgress}%` }} />
              </div>
              {loadProgress === 0 && <span className="loading-dots" aria-hidden="true" />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
