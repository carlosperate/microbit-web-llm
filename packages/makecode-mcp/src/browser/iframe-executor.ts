import type { BrowserExecutor, BlocksImage } from "../shared/types.js";
import { EMPTY_EDITOR_ERROR } from "../shared/project-defaults.js";
import {
  readCurrentCode,
  renderCurrentBlocks,
  writeCode,
} from "../shared/executor-ops.js";
import { createLogger, preview } from "../shared/logger.js";
import type { MakeCodeDriver } from "./driver-port.js";

const log = createLogger("executor");

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// One executor per iframe. The iframe *is* the session — callers don't open
// or close anything; the state lives in the iframe for as long as the
// executor instance is alive.
export class IframeExecutor implements BrowserExecutor {
  constructor(private readonly driver: MakeCodeDriver) {}

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
      throw err;
    } finally {
      end();
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

  async getHexFile(): Promise<string> {
    const end = log.time("getHexFile");
    try {
      const { hex } = await this.driver.compile();
      const base64 = utf8ToBase64(hex);
      log.info("getHexFile → ok", { hexBytes: hex.length, base64Bytes: base64.length });
      return base64;
    } catch (err) {
      log.error("getHexFile → error", err);
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

  async getHexFileFromCode(_code: string): Promise<string> {
    log.warn("getHexFileFromCode called on browser target (not supported)");
    throw new Error(
      "get_hex_file_from_code is not supported on the browser target. Use set_code + get_hex_file instead.",
    );
  }
}
