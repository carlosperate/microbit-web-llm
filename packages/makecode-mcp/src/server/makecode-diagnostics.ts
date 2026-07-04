// MakeCode logs TypeScript compile errors to the editor iframe's console as a
// single multi-line message, e.g.
//   error: main.ts(2,23): error TS2552: Cannot find name 'button'...
//   error: main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.
// The iframe is cross-origin, so only the Node side (via CDP `page.on('console')`)
// can read these; the in-page adapter can't. We capture them here so the server
// can enrich its otherwise-generic "failed to compile to blocks" error with the
// actual diagnostics, giving the model something concrete to fix.

// One TS diagnostic line: `<file>.ts(line,col): error TS####: message`. Anchored
// on the filename so the surrounding "error: " prefix and timestamps drop out.
const DIAGNOSTIC_RE = /\S+\.ts\(\d+,\d+\): error TS\d+:[^\n]*/g;

export function parseDiagnostics(consoleText: string): string[] {
  const matches = consoleText.match(DIAGNOSTIC_RE) ?? [];
  return [...new Set(matches.map((m) => m.trim()))];
}

export interface MakeCodeDiagnosticsOptions {
  /** Override the clock. Defaults to `Date.now`. Tests inject a fake. */
  now?: () => number;
}

/**
 * Per-page buffer of the most recent compile diagnostics seen on the console.
 * Only the latest compile matters (a fresh `session_set_code` supersedes the
 * last), so we keep a single timestamped set and expose it through a time
 * window so stale errors from an earlier program never attach to a new failure.
 */
export class MakeCodeDiagnostics {
  private latest: { diagnostics: string[]; at: number } | null = null;
  private readonly now: () => number;

  constructor(opts: MakeCodeDiagnosticsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  ingest(consoleText: string): void {
    const diagnostics = parseDiagnostics(consoleText);
    if (diagnostics.length === 0) return;
    this.latest = { diagnostics, at: this.now() };
  }

  recent(withinMs: number): string[] {
    if (!this.latest) return [];
    if (this.now() - this.latest.at > withinMs) return [];
    return this.latest.diagnostics;
  }
}
