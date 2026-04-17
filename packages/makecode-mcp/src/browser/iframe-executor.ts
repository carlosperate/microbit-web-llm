import type { MakeCodeExecutor, StartSessionResult } from "../shared/types.js";
import { SessionError } from "../shared/types.js";
import type { MakeCodeDriver } from "./driver-port.js";

const EMPTY_EDITOR_ERROR =
  "No code loaded in the editor. Call set_code first to load code before requesting get_blocks_svg.";

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `sid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export class IframeExecutor implements MakeCodeExecutor {
  private activeSessionId: string | null = null;

  constructor(private readonly driver: MakeCodeDriver) {}

  async startSession(): Promise<StartSessionResult> {
    const session_id = randomId();
    this.activeSessionId = session_id;
    return { session_id };
  }

  async endSession(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
    this.activeSessionId = null;
  }

  async getCurrentCode(sessionId: string): Promise<string> {
    this.requireSession(sessionId);
    const project = await this.driver.getProject();
    return project.text["main.ts"] ?? "";
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    this.requireSession(sessionId);
    const current = await this.driver.getProject();
    await this.driver.setProject({
      text: { ...current.text, "main.ts": code },
    });
  }

  async getBlocksSvg(sessionId: string): Promise<string> {
    this.requireSession(sessionId);
    const project = await this.driver.getProject();
    const code = project.text["main.ts"] ?? "";
    if (code.trim().length === 0) {
      throw new Error(EMPTY_EDITOR_ERROR);
    }
    return this.driver.renderBlocks(code);
  }

  async getHexFile(sessionId: string): Promise<string> {
    this.requireSession(sessionId);
    const { hex } = await this.driver.compile();
    return toBase64(hex);
  }

  async getBlocksSvgFromCode(code: string): Promise<string> {
    return this.driver.renderBlocks(code);
  }

  async getHexFileFromCode(_code: string): Promise<string> {
    throw new Error(
      "get_hex_file_from_code is not supported on the browser target. Use the server target or call set_code + get_hex_file within a session.",
    );
  }

  private requireSession(sessionId: string): void {
    if (!sessionId) {
      throw new SessionError(
        "missing",
        "session_id is required. Call start_session first.",
      );
    }
    if (this.activeSessionId !== sessionId) {
      throw new SessionError(
        "unknown",
        "session_id is not the active session. Call start_session to get a new one.",
      );
    }
  }
}
