import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MakeCodePanel } from "../../src/browser/MakeCodePanel.js";
import type { BrowserExecutor } from "../../src/shared/types.js";

const SAMPLE_CODE = `basic.forever(function() {
    basic.showNumber(input.temperature())
    basic.pause(1000)
})`;

function ImageModal({ pngBase64, onClose }: { pngBase64: string; onClose: () => void }) {
  const dataUrl = `data:image/png;base64,${pngBase64}`;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: 40,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#fff",
        }}
      >
        <button
          onClick={() => window.open(dataUrl, "_blank")}
          style={{ padding: "4px 10px", cursor: "pointer", borderRadius: 4, border: "none", background: "#fff" }}
        >
          Open in new tab
        </button>
        <button
          onClick={onClose}
          style={{ padding: "4px 10px", cursor: "pointer", borderRadius: 4, border: "none", background: "#fff" }}
        >
          Close (Esc)
        </button>
      </div>
      <img
        onClick={(e) => e.stopPropagation()}
        src={dataUrl}
        alt="blocks PNG"
        style={{ background: "#fff", borderRadius: 8, maxWidth: "90vw", maxHeight: "80vh" }}
      />
    </div>
  );
}

function App() {
  const executorRef = useRef<BrowserExecutor | null>(null);
  const [ready, setReady] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [code, setCode] = useState(SAMPLE_CODE);
  const [modalPng, setModalPng] = useState<string | null>(null);

  const append = (msg: string) =>
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  const handleExecutorReady = useCallback((executor: BrowserExecutor) => {
    executorRef.current = executor;
    setReady(true);
    append("executor ready");
  }, []);

  const exec = () => {
    if (!executorRef.current) throw new Error("executor not ready");
    return executorRef.current;
  };

  const handleSetCode = async () => {
    try {
      await exec().setCode(code);
      append("session_set_code → ok");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleGetCode = async () => {
    try {
      const result = await exec().getCurrentCode();
      append(`session_get_code → ${result.slice(0, 80)}…`);
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const showImage = (pngBase64: string, label: string) => {
    setModalPng(pngBase64);
    append(`${label} → ${(pngBase64.length / 1024).toFixed(1)} KB base64 — showing modal`);
  };

  const handleGetImage = async () => {
    try {
      const { pngBase64 } = await exec().getBlocksImage();
      showImage(pngBase64, "session_get_blocks_img");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleGetImageFromCode = async () => {
    try {
      const { pngBase64 } = await exec().getBlocksImageFromCode(code);
      showImage(pngBase64, "get_blocks_img_from_code");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const btn = (enabled: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    cursor: enabled ? "pointer" : "not-allowed",
    borderRadius: 4,
    border: "1px solid #ccc",
    background: "#f5f5f5",
    fontSize: 13,
    opacity: enabled ? 1 : 0.4,
  });

  return (
    <>
      {modalPng && (
        <ImageModal pngBase64={modalPng} onClose={() => setModalPng(null)} />
      )}

      <div style={{ display: "flex", height: "100%" }}>
        {/* Control panel */}
        <div
          style={{
            width: 300,
            minWidth: 300,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 12,
            borderRight: "1px solid #ddd",
            overflowY: "auto",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          <strong>MakeCode MCP — Test Page</strong>
          <span style={{ color: ready ? "green" : "gray" }}>
            {ready ? "executor ready" : "waiting for editor…"}
          </span>

          <hr />

          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={8}
            style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical", padding: 6 }}
          />

          <button style={btn(ready)} disabled={!ready} onClick={handleSetCode}>
            session_set_code
          </button>
          <button style={btn(ready)} disabled={!ready} onClick={handleGetCode}>
            session_get_code
          </button>

          <hr />

          <button style={btn(ready)} disabled={!ready} onClick={handleGetImage}>
            session_get_blocks_img (editor)
          </button>
          <button style={btn(ready)} disabled={!ready} onClick={handleGetImageFromCode}>
            get_blocks_img_from_code
          </button>

          <hr />

          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#555" }}>
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>

        {/* MakeCode panel */}
        <div style={{ flex: 1, position: "relative" }}>
          <MakeCodePanel
            onExecutorReady={handleExecutorReady}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </div>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
