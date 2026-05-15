// Lightweight namespaced logger.
// Browser: coloured console.{info,warn,error,debug} with a namespace prefix.
// Node: routes everything to console.error so the MCP stdio transport keeps
// stdout to itself. Disable via localStorage 'mkcp:log'='0', ?mkcp-log=0,
// MKCP_LOG=0, or VITEST/NODE_ENV=test. Pass long values through `preview()`.

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

const NOOP = (): void => {};

export function createLogger(namespace: string): Logger {
  const prefix = `[mkcp:${namespace}]`;
  const styled: [string, string] = [`%c${prefix}`, `color:${colorFor(namespace)};font-weight:600`];

  // Bind the console method with the prefix pre-applied — preserves the
  // caller's file:line in DevTools, unlike a wrapping function. In Node,
  // route everything to console.error so stdout stays free for MCP stdio.
  const bind = (method: Method): (...args: unknown[]) => void => {
    if (isNode) return console.error.bind(console, prefix);
    const fn = console[method] ?? console.log;
    return fn.bind(console, ...styled);
  };
  const bound = {
    info: bind("info"),
    warn: bind("warn"),
    error: bind("error"),
    debug: bind("debug"),
  };

  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  // Getters return either the bound console method (call site preserved) or a
  // noop, so the runtime `setLoggingEnabled` toggle still works.
  const logger = {
    get info() { return enabled ? bound.info : NOOP; },
    get warn() { return enabled ? bound.warn : NOOP; },
    get error() { return enabled ? bound.error : NOOP; },
    get debug() { return enabled ? bound.debug : NOOP; },
    group: (label: string, collapsed = false) => {
      if (!enabled) return;
      if (isNode) console.error(prefix, label);
      else (collapsed ? console.groupCollapsed : console.group).call(console, ...styled, label);
    },
    groupEnd: () => {
      if (enabled && !isNode) console.groupEnd();
    },
    time: (label: string) => {
      const start = now();
      return () => { if (enabled) bound.info(`${label} took ${(now() - start).toFixed(1)}ms`); };
    },
    child: (sub: string) => createLogger(`${namespace}:${sub}`),
  };
  return logger as Logger;
}

/** Summarise a large value as a short preview plus its length. */
export function preview(value: unknown, maxChars = 2000): string {
  if (value == null) return String(value);
  const s = typeof value === "string" ? value : safeStringify(value);
  if (s.length <= maxChars) return JSON.stringify(s);
  const head = s.slice(0, maxChars).replace(/\s+/g, " ");
  return `${JSON.stringify(head)}… (${s.length} chars)`;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
