// Lightweight namespaced logger for this POC.
//
// Works in both browser and Node. Enabled by default so the developer console
// (or stderr, for the MCP stdio server) shows a running trace of what the
// system is doing — model loading, tool dispatch, stall recovery, etc.
//
// Disable:
//   - Browser: `localStorage.setItem('mkcp:log', '0')` (or '?mkcp-log=0')
//   - Node:    set `MKCP_LOG=0`
//   - Tests:   auto-disabled when `VITEST` / `NODE_ENV=test` is set
//
// Usage:
//   const log = createLogger("tool-loop");
//   log.info("step", { finish, pending });
//   log.group("step 1"); ... log.groupEnd();
//   log.warn("stall detected, retrying");
//
// Long strings (code, SVG, hex) should be passed through `preview()` to get a
// size-annotated summary instead of spewing kilobytes into the console.

type ConsoleLike = {
  log: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  group?: (...args: unknown[]) => void;
  groupCollapsed?: (...args: unknown[]) => void;
  groupEnd?: () => void;
};

const isNode =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  !!process.versions?.node;

// In browsers we write to console.log/info/warn/error.
// In Node the stdio MCP server uses stdout for the protocol, so we must only
// touch stderr. We wrap process.stderr writes to mimic the console shape.
const sink: ConsoleLike = (() => {
  if (isNode) {
    const write = (level: string, args: unknown[]) => {
      const text = args
        .map((a) =>
          typeof a === "string"
            ? a
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })(),
        )
        .join(" ");
      try {
        process.stderr.write(`${level} ${text}\n`);
      } catch {
        // best-effort; never throw from the logger
      }
    };
    return {
      log: (...a) => write("[log]", a),
      info: (...a) => write("[info]", a),
      warn: (...a) => write("[warn]", a),
      error: (...a) => write("[error]", a),
      debug: (...a) => write("[debug]", a),
      group: (...a) => write("[group]", a),
      groupCollapsed: (...a) => write("[group]", a),
      groupEnd: () => {},
    };
  }
  return globalThis.console as ConsoleLike;
})();

function readEnabled(): boolean {
  try {
    if (isNode) {
      const env = (globalThis as any).process?.env ?? {};
      if (env.VITEST || env.NODE_ENV === "test") return false;
      if (env.MKCP_LOG === "0" || env.MKCP_LOG === "off") return false;
      return true;
    }
    // Browser
    const loc = (globalThis as any).location;
    if (loc?.search && /[?&]mkcp-log=(0|off)\b/.test(loc.search)) return false;
    const ls = (globalThis as any).localStorage;
    const v = ls?.getItem?.("mkcp:log");
    if (v === "0" || v === "off") return false;
    // Vitest jsdom env
    const env = (globalThis as any).process?.env ?? {};
    if (env.VITEST || env.NODE_ENV === "test") return false;
    return true;
  } catch {
    return true;
  }
}

let enabled = readEnabled();

export function setLoggingEnabled(on: boolean): void {
  enabled = on;
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

// Colours picked to be readable on light+dark devtools backgrounds.
const PALETTE = [
  "#0ea5e9", // sky
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#ef4444", // red
  "#14b8a6", // teal
  "#ec4899", // pink
  "#64748b", // slate
];

function colorFor(namespace: string): string {
  let h = 0;
  for (let i = 0; i < namespace.length; i++) h = (h * 31 + namespace.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  group: (label: string, collapsed?: boolean) => void;
  groupEnd: () => void;
  time: (label: string) => () => void; // returns endFn that logs elapsed ms
  child: (sub: string) => Logger;
}

export function createLogger(namespace: string): Logger {
  const prefix = `[mkcp:${namespace}]`;
  const color = colorFor(namespace);
  const stylePrefix = isNode ? prefix : `%c${prefix}`;
  const styleArgs = isNode ? [] : [`color:${color};font-weight:600`];

  const emit = (method: "log" | "info" | "warn" | "error" | "debug", args: unknown[]) => {
    if (!enabled) return;
    const fn = (sink[method] ?? sink.log).bind(sink);
    fn(stylePrefix, ...styleArgs, ...args);
  };

  return {
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    debug: (...args) => emit("debug", args),
    group: (label, collapsed = false) => {
      if (!enabled) return;
      const fn = ((collapsed ? sink.groupCollapsed : sink.group) ?? sink.log).bind(sink);
      fn(stylePrefix, ...styleArgs, label);
    },
    groupEnd: () => {
      if (!enabled) return;
      sink.groupEnd?.();
    },
    time: (label) => {
      const start =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      return () => {
        if (!enabled) return;
        const end =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        emit("info", [`${label} took ${(end - start).toFixed(1)}ms`]);
      };
    },
    child: (sub) => createLogger(`${namespace}:${sub}`),
  };
}

/** Summarise a large string (code, SVG, hex, JSON blob) as a short preview
 *  plus its length, so the console doesn't get flooded. */
export function preview(value: unknown, maxChars = 160): string {
  if (value == null) return String(value);
  const s = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  if (s.length <= maxChars) return JSON.stringify(s);
  const head = s.slice(0, maxChars).replace(/\s+/g, " ");
  return `${JSON.stringify(head)}… (${s.length} chars)`;
}
