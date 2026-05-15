import { randomUUID } from "node:crypto";
import type {
  BlocksImage,
  ServerExecutor,
  StartSessionOptions,
  StartSessionResult,
} from "../shared/types.js";
import { SessionError } from "../shared/types.js";
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

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;
/** Bound the expired-id history; once full, the oldest entries fall out and
 *  subsequent use of those ids returns "unknown" instead of "expired". */
const MAX_EXPIRED_HISTORY = 256;

export interface TabExecutorOptions {
  /**
   * Sessions whose last touch is older than this are closed by the background
   * reaper. Subsequent use of a reaped session returns `SessionError("expired")`.
   * Default: 30 minutes. Set to `0` (or negative) to disable.
   */
  idleTimeoutMs?: number;
  /**
   * How often the background reaper checks for stale sessions. Default: 1 min.
   * Set to `0` to disable the timer entirely (tests drive `reapIdleSessions()`
   * manually).
   */
  reapIntervalMs?: number;
  /** Override the clock. Defaults to `Date.now`. Tests inject a fake. */
  now?: () => number;
}

interface SessionEntry {
  tab: TabHandle;
  lastUsedAt: number;
}

export class TabExecutor implements ServerExecutor {
  private readonly sessions = new Map<string, SessionEntry>();
  /** Insertion-ordered set of recently reaped session ids so we can return
   *  `expired` instead of `unknown` for a bounded window after a reap. */
  private readonly expiredIds = new Set<string>();
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly pool: TabPool, opts: TabExecutorOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    const reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    if (this.idleTimeoutMs > 0 && reapIntervalMs > 0) {
      this.reapTimer = setInterval(() => this.reapIdleSessions(), reapIntervalMs);
      // Don't keep the Node process alive solely for this timer.
      this.reapTimer.unref?.();
    }
  }

  async startSession(opts?: StartSessionOptions): Promise<StartSessionResult> {
    const session_id = randomUUID();
    const tab = await this.pool.openTab(
      opts?.label !== undefined
        ? { sessionId: session_id, label: opts.label }
        : { sessionId: session_id },
    );
    this.sessions.set(session_id, { tab, lastUsedAt: this.now() });
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

  /**
   * Close any session whose last use is older than `idleTimeoutMs`. Exposed
   * so tests can drive the reaper deterministically; in production the
   * background interval calls it.
   */
  reapIdleSessions(): void {
    if (this.idleTimeoutMs <= 0) return;
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, entry] of this.sessions) {
      if (entry.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        entry.tab.close().catch(() => {});
        this.markExpired(id);
        log.info("reapIdleSessions → closed idle session", {
          session_id: id,
          idleMs: this.now() - entry.lastUsedAt,
        });
      }
    }
  }

  private markExpired(sessionId: string): void {
    this.expiredIds.add(sessionId);
    while (this.expiredIds.size > MAX_EXPIRED_HISTORY) {
      const oldest = this.expiredIds.values().next().value;
      if (oldest === undefined) break;
      this.expiredIds.delete(oldest);
    }
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
    return this.pool.withStatelessTab(async (d) => {
      // writeCode → setProject — same path session_set_code uses, so the
      // editor's decompile-confirm-wait detects TS that doesn't compile and
      // throws. Valid TS that can't decompile to blocks passes (the editor
      // still emits a post-switchBlocks workspacesave for it).
      await writeCode(d, code);
      // renderCurrentBlocks reads main.ts back and pipes it through the same
      // standalone renderer the session path uses, so the grey "raw text"
      // block falls out automatically for valid-but-undecompilable code.
      return renderCurrentBlocks(d);
    });
  }

  async getHexFileFromCode(code: string): Promise<string> {
    return this.pool.withStatelessTab(async (d) => {
      await writeCode(d, code);
      const { hex } = await d.compile();
      return toBase64(hex);
    });
  }

  async dispose(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    const tabs = [...this.sessions.values()].map((e) => e.tab);
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
    if (this.expiredIds.has(sessionId)) {
      throw new SessionError(
        "expired",
        `session_id has expired due to inactivity. Call ${TOOL.SESSION_START} to get a new one.`,
      );
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new SessionError(
        "unknown",
        `session_id is unknown. Call ${TOOL.SESSION_START} to get a new one.`,
      );
    }
    entry.lastUsedAt = this.now();
    return entry.tab;
  }
}
