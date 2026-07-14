// Compile-error message codecs shared by both diagnostics paths: the server
// (console scrape, puppeteer-driver.ts) and the browser (local pxt-mkc
// recompute, local-compiler.ts). Single source so the model-facing format
// can't drift between targets.

/** Matches the adapter's decompile-failure hint; both targets gate on it so
 *  transport errors never get diagnostics stapled on. */
export const COMPILE_TO_BLOCKS_RE = /failed to compile to blocks/i;

/** Structural twin of pxt's KsDiagnostic. Declared here rather than imported
 *  from makecode-core so the server build doesn't depend on it. */
export interface DiagnosticChain {
  messageText: string;
  code: number;
  next?: DiagnosticChain;
}

export interface CompilerDiagnostic {
  fileName?: string;
  /** 0-based, as pxt reports them. */
  line?: number;
  /** 0-based, as pxt reports them. */
  column?: number;
  code: number;
  /** pxt DiagnosticCategory: 0 warning, 1 error, 2 message. */
  category?: number;
  messageText: string | DiagnosticChain;
}

export function appendCompilerErrors(message: string, lines: string[]): string {
  if (lines.length === 0) return message;
  return `${message}\n\nCompiler errors:\n${lines.join("\n")}`;
}

/** Pre-validation rejection: the code never reached the editor (prevents
 *  MakeCode's blocking convert modal). Worded to not match
 *  COMPILE_TO_BLOCKS_RE so the server's console scrape doesn't re-enrich. */
export function compileRejectedError(toolName: string, lines: string[]): string {
  return appendCompilerErrors(
    `The code was not loaded because it does not compile. The editor still contains the previous code. Fix the TypeScript and call ${toolName} again.`,
    lines,
  );
}

/** `main.ts(L,C): error TS####: message` with chained messages indented on
 *  continuation lines (mirrors mkc's own CLI formatting). */
export function formatCompilerDiagnostic(d: CompilerDiagnostic): string {
  const prefix =
    d.fileName !== undefined ? `${d.fileName}(${(d.line ?? 0) + 1},${(d.column ?? 0) + 1}): ` : "";
  if (typeof d.messageText === "string") {
    return `${prefix}error TS${d.code}: ${d.messageText}`;
  }
  let text = `error TS${d.messageText.code}: ${d.messageText.messageText}`;
  let chain = d.messageText.next;
  let indent = 1;
  while (chain) {
    text += `\n${"  ".repeat(indent)}${chain.messageText}`;
    chain = chain.next;
    indent++;
  }
  return prefix + text;
}
