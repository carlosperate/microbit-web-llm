import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MakeCodePanel } from "../../src/browser/MakeCodePanel.js";
import type { MakeCodeExecutor } from "../../src/shared/types.js";

function cropSvgToContent(svgString: string, padding = 20): string {
  // Position off-screen so the browser performs full layout (required for getBBox).
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none";
  document.body.appendChild(wrap);
  try {
    wrap.innerHTML = svgString;
    const svg = wrap.querySelector("svg");
    if (!svg) return svgString;

    const contentEl =
      svg.querySelector<SVGGraphicsElement>("g.blocklyBlockCanvas") ??
      svg.querySelector<SVGGraphicsElement>("g[class*='blockly']") ??
      svg;

    let box: DOMRect;
    try {
      box = contentEl.getBBox();
    } catch {
      return svgString;
    }

    if (box.width === 0 || box.height === 0) return svgString;

    const x = box.x - padding;
    const y = box.y - padding;
    const w = box.width + padding * 2;
    const h = box.height + padding * 2;

    svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));

    return wrap.innerHTML;
  } finally {
    wrap.remove();
  }
}

const SAMPLE_CODE = `basic.forever(function() {
    basic.showNumber(input.temperature())
    basic.pause(1000)
})`;

function SvgModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const blobUrl = useMemo(() => {
    // Wrap in HTML so the browser parses it as HTML, not XML.
    // XML-mode rejects HTML entities like &nbsp; that MakeCode SVGs contain.
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;display:flex;align-items:flex-start;}</style></head><body>${svg}</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, [svg]);

  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const openInNewTab = () => {
    // Open in a new tab using the same HTML-wrapped blob so it renders correctly.
    window.open(blobUrl, "_blank");
  };

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
      {/* toolbar */}
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
        <span>{(svg.length / 1024).toFixed(1)} KB</span>
        <button
          onClick={openInNewTab}
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

      {/* SVG rendered in iframe so external CSS/fonts load correctly */}
      <iframe
        onClick={(e) => e.stopPropagation()}
        src={blobUrl}
        title="blocks SVG"
        style={{
          background: "#fff",
          borderRadius: 8,
          border: "none",
          width: "90vw",
          height: "80vh",
        }}
      />
    </div>
  );
}

function App() {
  const executorRef = useRef<MakeCodeExecutor | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [code, setCode] = useState(SAMPLE_CODE);
  const [modalSvg, setModalSvg] = useState<string | null>(null);

  const append = (msg: string) =>
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  const handleExecutorReady = useCallback((executor: MakeCodeExecutor) => {
    executorRef.current = executor;
    setReady(true);
    append("executor ready");
  }, []);

  const exec = () => {
    if (!executorRef.current) throw new Error("executor not ready");
    return executorRef.current;
  };

  const handleStartSession = async () => {
    try {
      const { session_id } = await exec().startSession();
      setSessionId(session_id);
      append(`start_session → ${session_id}`);
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleEndSession = async () => {
    if (!sessionId) return append("no active session");
    try {
      await exec().endSession(sessionId);
      setSessionId(null);
      append("end_session → ok");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleSetCode = async () => {
    if (!sessionId) return append("no active session");
    try {
      await exec().setCode(sessionId, code);
      append("set_code → ok");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleGetCode = async () => {
    if (!sessionId) return append("no active session");
    try {
      const result = await exec().getCurrentCode(sessionId);
      append(`get_current_code → ${result.slice(0, 80)}…`);
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const showSvg = (svg: string, label: string) => {
    const cropped = cropSvgToContent(svg);
    setModalSvg(cropped);
    append(`${label} → ${(svg.length / 1024).toFixed(1)} KB — showing modal`);
  };

  const handleGetSvg = async () => {
    if (!sessionId) return append("no active session");
    try {
      const result = await exec().getBlocksSvg(sessionId);
      showSvg(result, "get_blocks_svg");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleGetSvgFromCode = async () => {
    try {
      const result = await exec().getBlocksSvgFromCode(code);
      showSvg(result, "get_blocks_svg_from_code");
    } catch (e) {
      append(`ERROR: ${e}`);
    }
  };

  const handleGetHex = async () => {
    if (!sessionId) return append("no active session");
    try {
      const b64 = await exec().getHexFile(sessionId);
      const hex = atob(b64);
      const blob = new Blob([hex], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "microbit.hex";
      a.click();
      URL.revokeObjectURL(url);
      append(`get_hex_file → ${hex.length} bytes (downloading)`);
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
      {modalSvg && (
        <SvgModal svg={modalSvg} onClose={() => setModalSvg(null)} />
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
          <span style={{ color: sessionId ? "green" : "gray", wordBreak: "break-all" }}>
            {sessionId ? `session: ${sessionId.slice(0, 16)}…` : "no active session"}
          </span>

          <hr />

          <button style={btn(ready)} disabled={!ready} onClick={handleStartSession}>
            start_session
          </button>
          <button style={btn(!!sessionId)} disabled={!sessionId} onClick={handleEndSession}>
            end_session
          </button>

          <hr />

          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={8}
            style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical", padding: 6 }}
          />

          <button style={btn(!!sessionId)} disabled={!sessionId} onClick={handleSetCode}>
            set_code
          </button>
          <button style={btn(!!sessionId)} disabled={!sessionId} onClick={handleGetCode}>
            get_current_code
          </button>

          <hr />

          <button style={btn(!!sessionId)} disabled={!sessionId} onClick={handleGetSvg}>
            get_blocks_svg (session)
          </button>
          <button style={btn(ready)} disabled={!ready} onClick={handleGetSvgFromCode}>
            get_blocks_svg_from_code
          </button>
          <button style={btn(!!sessionId)} disabled={!sessionId} onClick={handleGetHex}>
            get_hex_file (download)
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
