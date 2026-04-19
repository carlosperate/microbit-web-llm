import type { BrowserExecutor } from "../shared/types.js";
import {
  EMPTY_EDITOR_ERROR,
  fillProjectDefaults,
} from "../shared/project-defaults.js";
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
      const project = await this.driver.getProject();
      const code = project.text["main.ts"] ?? "";
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
      const current = await this.driver.getProject();
      await this.driver.setProject({
        text: fillProjectDefaults(current.text, code),
      });
      log.info("setCode → ok");
    } catch (err) {
      log.error("setCode → error", err);
      throw err;
    } finally {
      end();
    }
  }

  async getBlocksSvg(): Promise<string> {
    const end = log.time("getBlocksSvg");
    try {
      const project = await this.driver.getProject();
      const code = project.text["main.ts"] ?? "";
      if (code.trim().length === 0) {
        log.warn("getBlocksSvg → editor empty, throwing for LLM self-correction");
        throw new Error(EMPTY_EDITOR_ERROR);
      }
      const svg = await this.driver.renderBlocks(code);
      log.info("getBlocksSvg → ok", { svgBytes: svg.length });
      return svg;
    } catch (err) {
      if ((err as Error).message !== EMPTY_EDITOR_ERROR) log.error("getBlocksSvg → error", err);
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

  async getBlocksSvgFromCode(code: string): Promise<string> {
    const end = log.time("getBlocksSvgFromCode");
    log.info("getBlocksSvgFromCode", { length: code.length, preview: preview(code) });
    try {
      const svg = await this.driver.renderBlocks(code);
      log.info("getBlocksSvgFromCode → ok", { svgBytes: svg.length });
      return svg;
    } catch (err) {
      log.error("getBlocksSvgFromCode → error", err);
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
