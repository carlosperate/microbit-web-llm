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

export interface MakeCodeExecutor {
  startSession(): Promise<StartSessionResult>;
  endSession(sessionId: string): Promise<void>;
  getCurrentCode(sessionId: string): Promise<string>;
  setCode(sessionId: string, code: string): Promise<void>;
  getBlocksSvg(sessionId: string): Promise<string>;
  getHexFile(sessionId: string): Promise<string>;
  getBlocksSvgFromCode(code: string): Promise<string>;
  getHexFileFromCode(code: string): Promise<string>;
}
