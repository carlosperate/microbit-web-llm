import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  MAX_STEPS_RANGE,
  MAX_TOKENS_RANGE,
  TEMPERATURE_RANGE,
  type AccentColor,
  type ChatSettings,
} from "./chat/settings.js";

export interface SettingsPanelProps {
  settings: ChatSettings;
  onChange: (next: ChatSettings) => void;
  onClose: () => void;
  onResetChat: () => void;
  onResetEditor: () => void;
}

const ACCENT_OPTIONS: { value: AccentColor; label: string; color: string }[] = [
  { value: "cyan",    label: "Cyan",    color: "#00C8E8" },
  { value: "teal",    label: "Teal",    color: "#00B4A0" },
  { value: "magenta", label: "Magenta", color: "#D4127A" },
];

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  onResetChat,
  onResetEditor,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<ChatSettings>(settings);
  const [maxTokensCapped, setMaxTokensCapped] = useState<boolean>(settings.maxTokens !== null);

  useEffect(() => {
    setDraft(settings);
    setMaxTokensCapped(settings.maxTokens !== null);
  }, [settings]);

  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    onChange(next);
  };

  const resetSystemPrompt = () => update("systemPrompt", DEFAULT_SETTINGS.systemPrompt);

  return (
    <div className="settings-overlay" data-testid="settings-overlay" role="dialog" aria-label="Chat settings">
      <div className="settings-header">
        <h2>Settings</h2>
        <button
          type="button"
          className="settings-close"
          onClick={onClose}
          aria-label="Close settings"
          data-testid="settings-close"
        >
          ×
        </button>
      </div>
      <div className="settings-body">

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="settings-field">
            <span style={{ fontSize: "0.85rem" }}>Accent colour</span>
            <div className="settings-swatches">
              {ACCENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`settings-swatch${draft.accentColor === opt.value ? " active" : ""}`}
                  style={draft.accentColor === opt.value ? { background: opt.color, borderColor: opt.color } : {}}
                  onClick={() => update("accentColor", opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>Sampling</h3>
          <label className="settings-field">
            <div className="settings-field-row">
              <span>Temperature</span>
              <span className="settings-field-value">{draft.temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={TEMPERATURE_RANGE.min}
              max={TEMPERATURE_RANGE.max}
              step={TEMPERATURE_RANGE.step}
              value={draft.temperature}
              onChange={(e) => update("temperature", Number(e.target.value))}
              data-testid="settings-temperature"
            />
            <p className="settings-help">
              Lower = more deterministic. Higher = more creative.
            </p>
          </label>

          <label className="settings-field">
            <div className="settings-field-row">
              <span>Cap response length</span>
              <input
                type="checkbox"
                checked={maxTokensCapped}
                onChange={(e) => {
                  setMaxTokensCapped(e.target.checked);
                  update("maxTokens", e.target.checked ? (draft.maxTokens ?? 1024) : null);
                }}
              />
            </div>
            {maxTokensCapped && (
              <input
                type="number"
                min={MAX_TOKENS_RANGE.min}
                max={MAX_TOKENS_RANGE.max}
                value={draft.maxTokens ?? 1024}
                onChange={(e) => update("maxTokens", Number(e.target.value))}
                data-testid="settings-max-tokens"
              />
            )}
            <p className="settings-help">
              Hard cap on tokens per reply. Off lets the model run to its own end-of-turn.
            </p>
          </label>
        </section>

        <section className="settings-section">
          <h3>Tool loop</h3>
          <label className="settings-field">
            <div className="settings-field-row">
              <span>Max tool steps</span>
              <span className="settings-field-value">{draft.maxSteps}</span>
            </div>
            <input
              type="range"
              min={MAX_STEPS_RANGE.min}
              max={MAX_STEPS_RANGE.max}
              step={1}
              value={draft.maxSteps}
              onChange={(e) => update("maxSteps", Number(e.target.value))}
              data-testid="settings-max-steps"
            />
            <p className="settings-help">
              Safety cap on tool-call iterations per turn. Raise it if the model legitimately needs many steps.
            </p>
          </label>
        </section>

        <section className="settings-section">
          <h3>System prompt</h3>
          <textarea
            className="settings-textarea"
            value={draft.systemPrompt}
            rows={10}
            onChange={(e) => update("systemPrompt", e.target.value)}
            data-testid="settings-system-prompt"
          />
          <button type="button" className="settings-secondary" onClick={resetSystemPrompt}>
            Reset to default
          </button>
          <p className="settings-help">
            Editing the prompt changes how the model is steered. Take a copy first if you want to compare.
          </p>
        </section>

        <section className="settings-section">
          <h3>Diagnostics</h3>
          <label className="settings-field-inline">
            <span>Verbose console logging</span>
            <input
              type="checkbox"
              checked={draft.verboseLogging}
              onChange={(e) => update("verboseLogging", e.target.checked)}
              data-testid="settings-verbose-logging"
            />
          </label>
          <p className="settings-help">
            Prints tool dispatches, timings, and stall recovery to the browser console.
          </p>
        </section>

        <section className="settings-section">
          <h3>Comparison mode</h3>
          <label className="settings-field-inline">
            <span>Enable comparison mode</span>
            <input
              type="checkbox"
              checked={draft.comparisonMode}
              onChange={(e) => update("comparisonMode", e.target.checked)}
              data-testid="settings-comparison-mode"
            />
          </label>
          <p className="settings-help">
            Show three models side by side with independent chat threads. Only one model runs at a time.
          </p>
        </section>

        <section className="settings-section">
          <h3>Reset</h3>
          <div className="settings-actions">
            <button type="button" className="settings-secondary" onClick={onResetChat}>
              Reset chat
            </button>
            <button type="button" className="settings-secondary" onClick={onResetEditor}>
              Reset editor
            </button>
          </div>
          <p className="settings-help">
            Reset chat clears the conversation but keeps the editor and model. Reset editor clears any loaded code.
          </p>
        </section>

      </div>
    </div>
  );
}

export default SettingsPanel;
