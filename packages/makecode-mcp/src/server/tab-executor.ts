import { randomUUID } from "node:crypto";
import type { MakeCodeDriver } from "../browser/driver-port.js";
import type { MakeCodeExecutor, StartSessionResult } from "../shared/types.js";
import { SessionError } from "../shared/types.js";
import {
  EMPTY_EDITOR_ERROR,
  fillProjectDefaults,
} from "../shared/project-defaults.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export class TabExecutor implements MakeCodeExecutor {
  private readonly sessions = new Map<string, TabHandle>();

  constructor(private readonly pool: TabPool) {}

  async startSession(): Promise<StartSessionResult> {
    const tab = await this.pool.openTab();
    const session_id = randomUUID();
    this.sessions.set(session_id, tab);
    return { session_id };
  }

  async endSession(sessionId: string): Promise<void> {
    const tab = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    await tab.close().catch(() => {});
  }

  async getCurrentCode(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const project = await driver.getProject();
    return project.text["main.ts"] ?? "";
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    const { driver } = this.requireSession(sessionId);
    const current = await driver.getProject();
    await driver.setProject({ text: fillProjectDefaults(current.text, code) });
  }

  async getBlocksSvg(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const project = await driver.getProject();
    const code = project.text["main.ts"] ?? "";
    if (code.trim().length === 0) throw new Error(EMPTY_EDITOR_ERROR);
    return driver.renderBlocks(code);
  }

  async getHexFile(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const { hex } = await driver.compile();
    return toBase64(hex);
  }

  async getBlocksSvgFromCode(code: string): Promise<string> {
    return this.pool.withTransientTab((d) => d.renderBlocks(code));
  }

  async getHexFileFromCode(code: string): Promise<string> {
    return this.pool.withTransientTab(async (d) => {
      await d.setProject({ text: fillProjectDefaults({}, code) });
      const { hex } = await d.compile();
      return toBase64(hex);
    });
  }

  async dispose(): Promise<void> {
    const tabs = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(tabs.map((t) => t.close().catch(() => {})));
    await this.pool.dispose();
  }

  private requireSession(sessionId: string): TabHandle {
    if (!sessionId) {
      throw new SessionError(
        "missing",
        "session_id is required. Call start_session first.",
      );
    }
    const tab = this.sessions.get(sessionId);
    if (!tab) {
      throw new SessionError(
        "unknown",
        "session_id is unknown. Call start_session to get a new one.",
      );
    }
    return tab;
  }
}
