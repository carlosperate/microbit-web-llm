import type { BrowserExecutor, BlocksImage } from "../shared/types.js";
import {
  COMPILE_TO_BLOCKS_RE,
  appendCompilerErrors,
} from "../shared/compile-errors.js";
import { EMPTY_EDITOR_ERROR } from "../shared/project-defaults.js";
import {
  readCurrentCode,
  renderCurrentBlocks,
  writeCode,
} from "../shared/executor-ops.js";
import { createLogger, preview } from "../shared/logger.js";
import type { MakeCodeDriver } from "./driver-port.js";
import { localCompiler } from "./local-compiler.js";

const log = createLogger("executor");

// One executor per iframe. The iframe *is* the session — callers don't open
// or close anything; the state lives in the iframe for as long as the
// executor instance is alive.
export class IframeExecutor implements BrowserExecutor {
  // Browser twin of PuppeteerDriver.compileError: the server reads the real TS
  // errors off the editor page's console (CDP), which the browser can't reach
  // (cross-origin iframe), so here they're recomputed locally via pxt-mkc.
  constructor(
    private readonly driver: MakeCodeDriver,
    private readonly localDiagnostics: (code: string) => Promise<string[]> = (code) =>
      localCompiler.getDiagnostics(code),
  ) {}

  async getCurrentCode(): Promise<string> {
    const end = log.time("getCurrentCode");
    try {
      const code = await readCurrentCode(this.driver);
      log.info("getCurrentCode → ok", { length: code.length, preview: preview(code) });
      return code;
    } catch (err) {
      log.error("getCurrentCode → error", err);
      throw err;
    } finally {
      end();
    }
  }

  async setCode(code: string): Promise<void> {
    const end = log.time("setCode");
    log.info("setCode", { length: code.length, preview: preview(code) });
    try {
      await writeCode(this.driver, code);
      log.info("setCode → ok");
    } catch (err) {
      log.error("setCode → error", err);
      throw await this.enrichCompileError(err, code);
    } finally {
      end();
    }
  }

  // Only genuine decompile failures get diagnostics; transport errors pass
  // through untouched. Fail-open: if the local compiler finds nothing (or
  // breaks), the original error survives unmodified.
  private async enrichCompileError(err: unknown, code: string): Promise<unknown> {
    if (!(err instanceof Error) || !COMPILE_TO_BLOCKS_RE.test(err.message)) return err;
    try {
      const lines = await this.localDiagnostics(code);
      if (lines.length === 0) return err;
      log.info("setCode → attached local compiler errors", { count: lines.length });
      return new Error(appendCompilerErrors(err.message, lines));
    } catch (diagErr) {
      log.warn("local diagnostics failed, keeping original error", diagErr);
      return err;
    }
  }

  async getBlocksImage(): Promise<BlocksImage> {
    const end = log.time("getBlocksImage");
    try {
      const result = await renderCurrentBlocks(this.driver);
      log.info("getBlocksImage → ok", { pngBytes: result.pngBase64.length });
      return result;
    } catch (err) {
      if ((err as Error).message === EMPTY_EDITOR_ERROR) {
        log.warn("getBlocksImage → editor empty, throwing for LLM self-correction");
      } else {
        log.error("getBlocksImage → error", err);
      }
      throw err;
    } finally {
      end();
    }
  }

  async getBlocksImageFromCode(code: string): Promise<BlocksImage> {
    const end = log.time("getBlocksImageFromCode");
    log.info("getBlocksImageFromCode", { length: code.length, preview: preview(code) });
    try {
      const pngBase64 = await this.driver.renderBlocksImage(code);
      log.info("getBlocksImageFromCode → ok", { pngBytes: pngBase64.length });
      return { pngBase64 };
    } catch (err) {
      log.error("getBlocksImageFromCode → error", err);
      throw err;
    } finally {
      end();
    }
  }

}
