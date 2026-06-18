import { useMemo } from "react";
import { useComposer, useThread } from "@assistant-ui/react";
import { tools as TOOL_SCHEMAS } from "makecode-mcp/browser";
import { estimateUsedTokens, levelForRatio } from "./context-meter.js";
import { buildToolsSystemPrompt } from "./webllm-engine.js";

// Geometry mirrors the CSS custom properties --composer-btn-size /
// --composer-btn-radius / --context-ring-outset; bump together.
const BUTTON_SIZE = 28;
const BUTTON_RADIUS = 8;
const RING_OUTSET = 3;
const STROKE_WIDTH = 3;
const RING_INSET = 2; // inset of the rect path from the viewBox edge so the stroke (half-width 1.5px) stays inside
const SVG_SIZE = BUTTON_SIZE + 2 * RING_OUTSET;
const RECT_SIZE = SVG_SIZE - 2 * RING_INSET;
const RECT_RX = BUTTON_RADIUS + (RING_OUTSET - RING_INSET);
const RECT_PERIMETER = 4 * (RECT_SIZE - 2 * RECT_RX) + 2 * Math.PI * RECT_RX;

const TOOLS_PROMPT_CHARS = buildToolsSystemPrompt(TOOL_SCHEMAS as unknown[]).length;

export function ContextRing({
  contextWindow,
  systemPrompt,
}: {
  contextWindow: number;
  systemPrompt: string;
}) {
  const messages = useThread((s) => s.messages);
  const composerText = useComposer((s) => s.text);
  const isRunning = useThread((s) => s.isRunning);

  const used = useMemo(
    () => estimateUsedTokens({ messages, composerText, systemPrompt, staticOverheadChars: TOOLS_PROMPT_CHARS }),
    [messages, composerText, systemPrompt],
  );
  const ratio = Math.min(used / contextWindow, 1);
  const level = levelForRatio(ratio);
  const dash = RECT_PERIMETER * ratio;
  const label = `Context ≈ ${formatTokens(used)} / ${formatTokens(contextWindow)} (estimated)`;

  return (
    <svg
      className={`context-ring${isRunning ? " context-ring-streaming" : ""}`}
      data-level={level}
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <rect className="context-ring-track" x={RING_INSET} y={RING_INSET} width={RECT_SIZE} height={RECT_SIZE} rx={RECT_RX} ry={RECT_RX} fill="none" strokeWidth={STROKE_WIDTH} />
      <rect
        className="context-ring-fill"
        x={RING_INSET}
        y={RING_INSET}
        width={RECT_SIZE}
        height={RECT_SIZE}
        rx={RECT_RX}
        ry={RECT_RX}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${RECT_PERIMETER - dash}`}
      />
    </svg>
  );
}

const formatTokens = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);
