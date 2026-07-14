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
import type { MakeCodeDriver } from "../browser/driver-port.js";
import { isDeadPageError } from "./page-errors.js";
import type { TabHandle, TabPool } from "./tab-pool.js";

const log = createLogger("tab-executor");
/** Shown for any gone session, whether idle-reaped or its tab died (Chrome
 *  discarded it, or the user closed the window in headed mode). */
const SESSION_GONE_MSG = `session_id is no longer available. The editor window was closed or the session timed out. Call ${TOOL.SESSION_START} to get a new one.`;
const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The shared adapter's compile errors (pre-validation rejection or decompile
 *  hint) say to call session_set_code, but on the stateless path there is no
 *  session; retry the calling tool instead. */
function retargetCompileHint(err: unknown, toolName: string): unknown {
  if (err instanceof Error && err.message.includes(TOOL.SESSION_SET_CODE)) {
    return new Error(err.message.replaceAll(TOOL.SESSION_SET_CODE, toolName));
  }
  return err;
}

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
        this.expireSession(id, entry);
        log.info("reapIdleSessions → closed idle session", {
          session_id: id,
          idleMs: this.now() - entry.lastUsedAt,
        });
      }
    }
  }

  /** Drop a session and remember it as expired: remove it from the map, close
   *  its tab in the background, and record the id so later use reports
   *  `expired` rather than `unknown`. Shared by the idle reaper and dead-tab
   *  recovery. */
  private expireSession(id: string, entry: SessionEntry): void {
    this.sessions.delete(id);
    entry.tab.close().catch(() => {});
    this.markExpired(id);
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
    return this.runSession(sessionId, (driver) => readCurrentCode(driver));
  }

  async setCode(sessionId: string, code: string): Promise<void> {
    await this.runSession(sessionId, (driver) => writeCode(driver, code));
  }

  async getBlocksImage(sessionId: string): Promise<BlocksImage> {
    return this.runSession(sessionId, (driver) => renderCurrentBlocks(driver));
  }

  async getHexFile(sessionId: string): Promise<string> {
    return this.runSession(sessionId, async (driver) => {
      const { hex } = await driver.compile();
      return toBase64(hex);
    });
  }

  /**
   * Resolve the session, run `fn` against its driver, and translate a dead-page
   * failure (tab discarded by Chrome, or window closed by the user in headed
   * mode) into a clean `SessionError("expired")`. Dropping the dead session lets
   * the model start a fresh one instead of seeing a raw Puppeteer
   * "detached Frame" string. Other errors propagate unchanged so the model can
   * still self-correct on e.g. uncompilable TS.
   */
  private async runSession<T>(
    sessionId: string,
    fn: (driver: MakeCodeDriver) => Promise<T>,
  ): Promise<T> {
    const { driver } = this.requireSession(sessionId);
    try {
      return await fn(driver);
    } catch (err) {
      if (isDeadPageError(err)) throw this.dropDeadSession(sessionId, err);
      throw err;
    }
  }

  private dropDeadSession(sessionId: string, err: unknown): SessionError {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.expireSession(sessionId, entry);
      log.warn("session tab died, closing and expiring", {
        session_id: sessionId,
        error: String(err),
      });
    }
    return new SessionError("expired", SESSION_GONE_MSG);
  }

  async getBlocksImageFromCode(code: string): Promise<BlocksImage> {
    return this.pool.withStatelessTab(async (d) => {
      // writeCode → setProject — same path session_set_code uses, so the
      // editor's decompile-confirm-wait detects TS that doesn't compile and
      // throws. Valid TS that can't decompile to blocks passes (the editor
      // still emits a post-switchBlocks workspacesave for it).
      try {
        await writeCode(d, code);
      } catch (err) {
        throw retargetCompileHint(err, TOOL.GET_BLOCKS_IMG_FROM_CODE);
      }
      // renderCurrentBlocks reads main.ts back and pipes it through the same
      // standalone renderer the session path uses, so the grey "raw text"
      // block falls out automatically for valid-but-undecompilable code.
      return renderCurrentBlocks(d);
    });
  }

  async getHexFileFromCode(code: string): Promise<string> {
    return this.pool.withStatelessTab(async (d) => {
      try {
        await writeCode(d, code);
      } catch (err) {
        throw retargetCompileHint(err, TOOL.GET_HEX_FILE_FROM_CODE);
      }
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
      throw new SessionError("expired", SESSION_GONE_MSG);
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
