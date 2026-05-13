import { randomUUID } from "node:crypto";
import type {
  BlocksImage,
  ServerExecutor,
  StartSessionOptions,
  StartSessionResult,
} from "../shared/types.js";
import { SessionError } from "../shared/types.js";
import { fillProjectDefaults } from "../shared/project-defaults.js";
import { TOOL } from "../shared/tools.js";
import {
  readCurrentCode,
  renderCurrentBlocks,
  writeCode,
} from "../shared/executor-ops.js";
import { createLogger } from "../shared/logger.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

const log = createLogger("tab-executor");
const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export class TabExecutor implements ServerExecutor {
  private readonly sessions = new Map<string, TabHandle>();

  constructor(private readonly pool: TabPool) {}

  async startSession(opts?: StartSessionOptions): Promise<StartSessionResult> {
    const session_id = randomUUID();
    const tab = await this.pool.openTab(
      opts?.label !== undefined
        ? { sessionId: session_id, label: opts.label }
        : { sessionId: session_id },
    );
    this.sessions.set(session_id, tab);
    log.info("startSession → new tab", {
      session_id,
      label: opts?.label,
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
    return readCurrentCode(driver);
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    const { driver } = this.requireSession(sessionId);
    await writeCode(driver, code);
  }

  async getBlocksImage(sessionId: string): Promise<BlocksImage> {
    const { driver } = this.requireSession(sessionId);
    return renderCurrentBlocks(driver);
  }

  async getHexFile(sessionId: string): Promise<string> {
    const { driver } = this.requireSession(sessionId);
    const { hex } = await driver.compile();
    return toBase64(hex);
  }

  async getBlocksImageFromCode(code: string): Promise<BlocksImage> {
    const pngBase64 = await this.pool.renderBlocksImage(code);
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
        `session_id is required. Call ${TOOL.SESSION_START} first.`,
      );
    }
    const tab = this.sessions.get(sessionId);
    if (!tab) {
      throw new SessionError(
        "unknown",
        `session_id is unknown. Call ${TOOL.SESSION_START} to get a new one.`,
      );
    }
    return tab;
  }
}
