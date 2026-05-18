import { AssistantRuntimeProvider, type ChatModelAdapter, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "../chat/Thread.js";
import { MODELS, type ModelId } from "../chat/webllm-engine.js";
import type { PanelIndex } from "./ComparisonLayout.js";

export interface ChatPanelViewProps {
  index: PanelIndex;
  isActive: boolean;
  modelId: ModelId;
  onModelChange: (modelId: ModelId) => void;
  onSwitchActive: () => void;
  adapter: ChatModelAdapter;
}

export function ChatPanelView({
  index,
  isActive,
  modelId,
  onModelChange,
  onSwitchActive,
  adapter,
}: ChatPanelViewProps) {
  const runtime = useLocalRuntime(adapter);
  const selectedModel = MODELS.find((m) => m.id === modelId);

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
      </div>
    </div>
  );
}
