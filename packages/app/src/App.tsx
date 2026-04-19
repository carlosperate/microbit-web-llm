import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { MakeCodePanel } from "makecode-mcp/browser";
import type { BrowserExecutor } from "makecode-mcp/browser";
import { createLogger, isLoggingEnabled, setLoggingEnabled } from "makecode-mcp/browser";
import { createChatAdapter } from "./chat/adapter.js";
import type { ChatCompletionFn } from "./chat/tool-loop.js";
import { Thread } from "./chat/Thread.js";
import { loadWebLLM, isWebGPUSupported, MODELS, MODEL_ID, type LoadState, type ModelId } from "./chat/webllm-engine.js";
import { DEFAULT_SETTINGS, type ChatSettings } from "./chat/settings.js";
import { SettingsPanel } from "./SettingsPanel.js";

const log = createLogger("app");

type ChatAdapter = ReturnType<typeof createChatAdapter>;

/** Hosts its own runtime so remounting this component (via `key`) gives a
 *  fresh, empty thread — used to reset the conversation when the model
 *  changes without touching the MakeCode iframe. */
function ChatThread({ adapter }: { adapter: ChatAdapter }) {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

export function App(props: {
  /** Optional override for tests: pre-built completion function bypassing WebLLM loading. */
  mockCompletion?: ChatCompletionFn;
}) {
  const [loadState, setLoadState] = useState<LoadState>(
    props.mockCompletion
      ? { status: "ready" }
      : isWebGPUSupported()
        ? { status: "idle" }
        : { status: "unsupported", reason: "WebGPU is not available. Please use Chrome 113+ on a supported GPU." },
  );
  const [selectedModelId, setSelectedModelId] = useState<ModelId>(MODEL_ID);
  const [loadedModelId, setLoadedModelId] = useState<ModelId | null>(props.mockCompletion ? MODEL_ID : null);
  // Incremented whenever a new model finishes loading OR the user resets the
  // chat, so the chat subtree remounts with a fresh runtime. Kept separate
  // from loadedModelId so re-loading the same model id still counts as a new
  // conversation.
  const [chatEpoch, setChatEpoch] = useState(0);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<ChatSettings>(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const completionRef = useRef<ChatCompletionFn | null>(props.mockCompletion ?? null);
  const executorRef = useRef<BrowserExecutor | null>(null);
  // Not shown to users — exposed as a data attribute on the chat pane so
  // tests can wait for the iframe executor to hand over without the UI
  // having to display a noisy "editor ready" badge.
  const [executorReady, setExecutorReady] = useState(false);

  const loadModel = useCallback(async (modelId: ModelId) => {
    if (props.mockCompletion) return;
    log.info("loadModel requested", { modelId });
    setLoadState({ status: "loading", progress: 0, text: "Starting…", modelId });
    try {
      completionRef.current = await loadWebLLM(
        (r) => setLoadState({ status: "loading", progress: r.progress ?? 0, text: r.text, modelId }),
        modelId,
      );
      setLoadedModelId(modelId);
      setChatEpoch((n) => n + 1);
      setLoadState({ status: "ready" });
      log.info("model ready → chat thread remounted (new epoch)", { modelId });
    } catch (err) {
      log.error("model load failed", err);
      completionRef.current = null;
      setLoadedModelId(null);
      setLoadState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
    }
  }, [props.mockCompletion]);

  const ensureLoaded = useCallback(async () => {
    if (completionRef.current && loadedModelId === selectedModelId) return;
    await loadModel(selectedModelId);
  }, [loadModel, loadedModelId, selectedModelId]);

  const adapter = useMemo(
    () =>
      createChatAdapter({
        completion: async (args) => {
          await ensureLoaded();
          const completion = completionRef.current;
          if (!completion) throw new Error("Model did not finish loading.");
          return completion(args);
        },
        getExecutor: () => executorRef.current,
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
    [ensureLoaded],
  );

  const handleExecutorReady = useCallback((executor: BrowserExecutor) => {
    log.info("MakeCode executor ready");
    executorRef.current = executor;
    setExecutorReady(true);
  }, []);

  useEffect(() => {
    // Print a one-time banner so a user opening devtools sees where logs
    // come from and how to silence them.
    if (isLoggingEnabled()) {
      // eslint-disable-next-line no-console
      console.log(
        "%c[mkcp]",
        "color:#0ea5e9;font-weight:700",
        "verbose logging ON. Disable with: localStorage.setItem('mkcp:log','0') then reload, or add ?mkcp-log=0 to the URL.",
      );
    }
  }, []);

  const handleSettingsChange = useCallback((next: ChatSettings) => {
    setSettings(next);
    // Verbose logging is the one setting with a side-effect outside state.
    setLoggingEnabled(next.verboseLogging);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("mkcp:log", next.verboseLogging ? "1" : "0");
      }
    } catch {
      /* best-effort */
    }
  }, []);

  const handleResetChat = useCallback(() => {
    log.info("user: reset chat");
    setChatEpoch((n) => n + 1);
  }, []);

  const handleResetEditor = useCallback(() => {
    log.info("user: reset editor");
    executorRef.current?.setCode("").catch((err) => log.warn("reset editor failed", err));
  }, []);

  const modelLoaded = loadedModelId === selectedModelId && loadState.status === "ready";
  const modelLoading = loadState.status === "loading";

  return (
    <div className="app-root">
      <div className="chat-pane" data-executor-ready={executorReady ? "true" : "false"}>
        <header className="chat-header">
          <span>micro:bit Assistant</span>
          <div className="model-picker">
            <select
              className="model-select"
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value as ModelId)}
              disabled={modelLoading}
              data-testid="model-select"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id} title={m.label}>{m.shortLabel}</option>
              ))}
            </select>
            {modelLoaded ? (
              <span className="model-loaded" data-testid="model-status">model loaded</span>
            ) : (
              <button
                className="model-load-btn"
                onClick={() => loadModel(selectedModelId)}
                disabled={modelLoading}
                data-testid="model-load"
              >
                {modelLoading ? "Loading…" : "Load model"}
              </button>
            )}
          </div>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setSettingsOpen((v) => !v)}
            disabled={modelLoading}
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            data-testid="settings-toggle"
            title="Settings"
          >
            <SettingsIcon />
          </button>
        </header>
        <div className="chat-body">
          <ChatThread key={chatEpoch} adapter={adapter} />
          {!modelLoaded && loadState.status !== "loading" && loadState.status !== "unsupported" && loadState.status !== "error" && (
            <ModelNotLoadedOverlay />
          )}
          <LoadOverlay state={loadState} onRetry={() => loadModel(selectedModelId)} />
        </div>
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onChange={handleSettingsChange}
            onClose={() => setSettingsOpen(false)}
            onResetChat={() => {
              handleResetChat();
              setSettingsOpen(false);
            }}
            onResetEditor={handleResetEditor}
          />
        )}
      </div>
      <div className="editor-pane">
        <MakeCodePanel onExecutorReady={handleExecutorReady} />
      </div>
    </div>
  );
}

function ModelNotLoadedOverlay() {
  return (
    <div className="model-gate-overlay" data-testid="model-not-loaded">
      <div className="model-gate-card">
        <h3>Load a model to begin</h3>
        <p>
          Pick a model from the dropdown above and click <strong>Load model</strong>. The
          first load downloads ~4–5 GB and is cached for future visits.
        </p>
      </div>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function LoadOverlay({ state, onRetry }: { state: LoadState; onRetry: () => void }) {
  if (state.status === "idle" || state.status === "ready") return null;
  if (state.status === "unsupported") {
    return (
      <div className="loading-overlay loading-overlay-error" data-testid="load-overlay">
        <h3>WebGPU required</h3>
        <p>{state.reason}</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="loading-overlay loading-overlay-error" data-testid="load-overlay">
        <h3>Model failed to load</h3>
        <p>{state.error.message}</p>
        <button className="composer-send" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  const pct = Math.round((state.progress ?? 0) * 100);
  const modelLabel = MODELS.find((m) => m.id === state.modelId)?.label ?? state.modelId;
  return (
    <div className="loading-overlay" data-testid="load-overlay">
      <h3>Loading {modelLabel}…</h3>
      <p>First run downloads ~4–5 GB and is cached for future visits.</p>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p style={{ fontSize: "0.75rem" }}>{state.text}</p>
    </div>
  );
}

export default App;
