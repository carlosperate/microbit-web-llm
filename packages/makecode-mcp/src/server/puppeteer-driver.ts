import type { MakeCodeDriver, MakeCodeProjectFiles } from "../browser/driver-port.js";
import type { PageLike } from "./browser-pool.js";

// These browser-side lambdas run inside the puppeteer page, where the shim
// has installed `window.__mkcp` (see src/server/shell/shim.ts). We cast
// through `unknown` because page.evaluate's signature is intentionally loose.

export class PuppeteerDriver implements MakeCodeDriver {
  constructor(private readonly page: PageLike) {}

  getProject(): Promise<MakeCodeProjectFiles> {
    return this.page.evaluate(
      `window.__mkcp.saveProject()`,
    ) as Promise<MakeCodeProjectFiles>;
  }

  async setProject(project: MakeCodeProjectFiles): Promise<void> {
    await this.page.evaluate(
      (text: unknown) =>
        (window as unknown as { __mkcp: { importProject(t: unknown): Promise<void> } })
          .__mkcp.importProject(text),
      project.text,
    );
  }

  compile(): Promise<{ name: string; hex: string }> {
    return this.page.evaluate(`window.__mkcp.compile()`) as Promise<{
      name: string;
      hex: string;
    }>;
  }

  renderBlocks(code: string): Promise<string> {
    return this.page.evaluate(
      (c: unknown) =>
        (window as unknown as { __mkcp: { renderBlocks(c: unknown): Promise<string> } })
          .__mkcp.renderBlocks(c),
      code,
    ) as Promise<string>;
  }
}
