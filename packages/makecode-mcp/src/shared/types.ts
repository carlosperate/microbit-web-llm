export type SessionErrorCode = "missing" | "unknown" | "expired";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export function isSessionError(x: unknown): x is SessionError {
  return x instanceof SessionError;
}

export interface StartSessionResult {
  session_id: string;
}

export interface BlocksImage {
  pngBase64: string;
}

// Browser target: one executor per iframe. The iframe *is* the session, so
// callers don't pass a session_id and there is no start/end lifecycle.
export interface BrowserExecutor {
  getCurrentCode(): Promise<string>;
  setCode(code: string): Promise<void>;
  getBlocksImage(): Promise<BlocksImage>;
  getBlocksImageFromCode(code: string): Promise<BlocksImage>;
}

// Server target: one MCP server can multiplex many LLM clients, so sessions
// are first-class. Each session maps to a puppeteer tab.
export interface StartSessionOptions {
  /** Human label shown in the OS window title when the server runs headed. */
  label?: string;
}

export interface ServerExecutor {
  startSession(opts?: StartSessionOptions): Promise<StartSessionResult>;
  endSession(sessionId: string): Promise<void>;
  getCurrentCode(sessionId: string): Promise<string>;
  setCode(sessionId: string, code: string): Promise<void>;
  getBlocksImage(sessionId: string): Promise<BlocksImage>;
  getHexFile(sessionId: string): Promise<string>;
  getBlocksImageFromCode(code: string): Promise<BlocksImage>;
  getHexFileFromCode(code: string): Promise<string>;
}
