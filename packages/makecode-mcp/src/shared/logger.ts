// Lightweight namespaced logger for this POC.
//
// Browser: writes to console.{info,warn,error,debug} with a coloured namespace
// prefix. Node: routes everything to console.error so the MCP stdio transport
// keeps stdout to itself; console.error pretty-prints + stringifies its
// arguments for free.
//
// Disable:
//   - Browser: `localStorage.setItem('mkcp:log', '0')` (or `?mkcp-log=0`)
//   - Node:    set `MKCP_LOG=0`
//   - Tests:   auto-disabled when `VITEST` / `NODE_ENV=test` is set
//
// Long values (code, SVG, hex) should be passed through `preview()`.

const isNode =
  typeof process !== "undefined" && !!process.versions?.node;

function readEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
  if (env.VITEST || env.NODE_ENV === "test") return false;
  if (isNode) return env.MKCP_LOG !== "0" && env.MKCP_LOG !== "off";
  const loc = (globalThis as { location?: { search?: string } }).location;
  if (loc?.search && /[?&]mkcp-log=(0|off)\b/.test(loc.search)) return false;
  const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem?.("mkcp:log");
  return v !== "0" && v !== "off";
}

let enabled = readEnabled();
export function setLoggingEnabled(on: boolean): void { enabled = on; }
export function isLoggingEnabled(): boolean { return enabled; }

const PALETTE = ["#0ea5e9", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#ec4899", "#64748b"];
function colorFor(ns: string): string {
  let h = 0;
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

type Method = "info" | "warn" | "error" | "debug";

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  group: (label: string, collapsed?: boolean) => void;
  groupEnd: () => void;
  time: (label: string) => () => void;
  child: (sub: string) => Logger;
}

export function createLogger(namespace: string): Logger {
  const prefix = `[mkcp:${namespace}]`;
  const styled: [string, string] = [`%c${prefix}`, `color:${colorFor(namespace)};font-weight:600`];

  // In Node, route everything to console.error (writes to stderr; preserves
  // stdout for the MCP stdio transport). In the browser, use the matching
  // console method so devtools filter levels correctly.
  const emit = (method: Method, args: unknown[]) => {
    if (!enabled) return;
    if (isNode) console.error(prefix, ...args);
    else (console[method] ?? console.log).call(console, ...styled, ...args);
  };

  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
    debug: (...a) => emit("debug", a),
    group: (label, collapsed = false) => {
      if (!enabled) return;
      if (isNode) console.error(prefix, label);
      else (collapsed ? console.groupCollapsed : console.group).call(console, ...styled, label);
    },
    groupEnd: () => {
      if (enabled && !isNode) console.groupEnd();
    },
    time: (label) => {
      const start = now();
      return () => emit("info", [`${label} took ${(now() - start).toFixed(1)}ms`]);
    },
    child: (sub) => createLogger(`${namespace}:${sub}`),
  };
}

/** Summarise a large value as a short preview plus its length. */
export function preview(value: unknown, maxChars = 160): string {
  if (value == null) return String(value);
  const s = typeof value === "string" ? value : safeStringify(value);
  if (s.length <= maxChars) return JSON.stringify(s);
  const head = s.slice(0, maxChars).replace(/\s+/g, " ");
  return `${JSON.stringify(head)}… (${s.length} chars)`;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
