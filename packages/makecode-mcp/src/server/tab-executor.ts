import { randomUUID } from "node:crypto";
import type { MakeCodeDriver } from "../browser/driver-port.js";
import type {
  BlocksImage,
  ServerExecutor,
  StartSessionResult,
} from "../shared/types.js";
import { SessionError } from "../shared/types.js";
import {
  EMPTY_EDITOR_ERROR,
  fillProjectDefaults,
} from "../shared/project-defaults.js";
import { createLogger } from "../shared/logger.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

const log = createLogger("tab-executor");
const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export class TabExecutor implements ServerExecutor {
  private readonly sessions = new Map<string, TabHandle>();

  constructor(private readonly pool: TabPool) {}

  async startSession(): Promise<StartSessionResult> {
    const tab = await this.pool.openTab();
    const session_id = randomUUID();
    this.sessions.set(session_id, tab);
    log.info("startSession → new tab", {
      session_id,
      openSessions: this.sessions.size,
    });
    return { session_id };
  }

  async endSession(sessionId: string): Promise<void> {
    const tab = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    await tab.close().catch(() => {});
    log.info("endSession → tab closed", {
      session_id: sessionId,
      openSessions: this.sessions.size,
    });
  }

  async getCurrentCode(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const project = await driver.getProject();
    return project.text["main.ts"] ?? "";
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    const { driver } = this.requireSession(sessionId);
    const current = await driver.getProject();
    // Drop main.blocks so the blocks view re-decompiles from the new main.ts.
    // Otherwise MakeCode boots in blocks mode, renders the stale (empty) blocks
    // XML, and overwrites main.ts with the decompiled result ("\n").
    const { "main.blocks": _drop, ...rest } = current.text;
    await driver.setProject({
      text: { ...fillProjectDefaults(rest, code), "main.blocks": "" },
    });
  }

  async getBlocksImage(sessionId: string): Promise<BlocksImage> {
    const { driver } = this.requireSession(sessionId);
    const project = await driver.getProject();
    const code = project.text["main.ts"] ?? "";
    if (code.trim().length === 0) throw new Error(EMPTY_EDITOR_ERROR);
    const pngBase64 = await driver.renderBlocksImage(code);
    return { pngBase64 };
  }

  async getHexFile(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const { hex } = await driver.compile();
    return toBase64(hex);
  }

  async getBlocksImageFromCode(code: string): Promise<BlocksImage> {
    const pngBase64 = await this.pool.withTransientTab((d) =>
      d.renderBlocksImage(code),
    );
    return { pngBase64 };
  }

  async getHexFileFromCode(code: string): Promise<string> {
    return this.pool.withTransientTab(async (d) => {
      await d.setProject({
        text: { ...fillProjectDefaults({}, code), "main.blocks": "" },
      });
      const { hex } = await d.compile();
      return toBase64(hex);
    });
  }

  async dispose(): Promise<void> {
    const tabs = [...this.sessions.values()];
    log.info("dispose → closing sessions and pool", { openSessions: tabs.length });
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
