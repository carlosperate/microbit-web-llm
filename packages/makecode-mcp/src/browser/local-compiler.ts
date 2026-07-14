// Local recompute of MakeCode TS diagnostics for the browser target.
//
// The editor iframe is cross-origin: its console (where MakeCode logs the real
// TS errors) is unreachable, and the protocol's `workspacediagnostics` event is
// gated on a target theme flag makecode.microbit.org doesn't set. So instead of
// reading the editor's diagnostics we recompute them with MakeCode's own
// compiler via pxt-mkc (makecode-core + makecode-browser): it downloads the
// live editor's pxtworker.js + target.json (same URLs the iframe loads, so
// versions track by construction; mkc re-checks for updates at most once a day)
// and runs the identical compiler in a web worker.
import {
  formatCompilerDiagnostic,
  type CompilerDiagnostic,
} from "../shared/compile-errors.js";
import { lazyRetry } from "../shared/lazy-retry.js";
import { createLogger, preview, type Logger } from "../shared/logger.js";
import { createMemoryHost, createMkcCache } from "./mkc-host.js";

const log = createLogger("local-compiler");

// Same site the MakeCodePanel iframe embeds; mkc fetches its compiler from here.
const MAKECODE_WEBSITE = "https://makecode.microbit.org/";

export interface CompilerEngine {
  compile(
    code: string,
    dependencies?: Record<string, string>,
  ): Promise<{ success: boolean; diagnostics: CompilerDiagnostic[] }>;
}

/** Route mkc's internal console.log lines ("Download https://...", "GET ...")
 *  through our namespaced logger so DevTools output from the local compiler is
 *  always `[mkcp:local-compiler]`-prefixed and can't be mistaken for the
 *  MakeCode iframe's own console traffic. */
export function wireMkcLogging(
  mkcModule: {
    setLogging(fns: {
      log(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    }): void;
  },
  logger: Pick<Logger, "info" | "error" | "debug">,
): void {
  // Arrow wrappers keep the logger's runtime enable/disable getters live.
  mkcModule.setLogging({
    log: (msg) => logger.info(msg),
    error: (msg) => logger.error(msg),
    debug: (msg) => logger.debug(msg),
  });
}

async function createMkcEngine(): Promise<CompilerEngine> {
  // path-browserify's resolve() calls process.cwd() (mkc does path.resolve(".", dir)).
  const g = globalThis as { process?: { env?: object; cwd?: () => string } };
  if (!g.process) g.process = { env: {} };
  if (!g.process.cwd) g.process.cwd = () => "/";

  // Dynamic imports: bundlers put mkc in an async chunk loaded on first use.
  // makecode-browser is preloaded here so the language-service factory below
  // is sync-fast: mkc's Ctx constructor fire-and-forgets initAsync(), and a
  // slow factory loses that race (first compile sees no language service).
  const [mkc, { setHost }, { BrowserLanguageService }] = await Promise.all([
    import("makecode-core/built/mkc"),
    import("makecode-core/built/host"),
    import("makecode-browser/built/languageService"),
  ]);
  wireMkcLogging(mkc, log);

  const { host, seedFile } = createMemoryHost({
    createLanguageService: (editor) => new BrowserLanguageService(editor),
  });
  setHost(host);
  const seedPxtJson = (dependencies: Record<string, string>) =>
    seedFile(
      "prj/pxt.json",
      JSON.stringify({ name: "mkcp-local-diagnostics", files: ["main.ts"], dependencies }),
    );
  seedPxtJson({ core: "*" });
  seedFile("prj/mkc.json", JSON.stringify({ targetWebsite: MAKECODE_WEBSITE }));
  seedFile("prj/main.ts", "");

  const project = new mkc.Project("prj", createMkcCache());
  project.writePxtModules = false;
  const end = log.time("editor compiler download/init");
  await project.loadEditorAsync();
  // Barrier for Ctx's dropped initAsync() promise. Once languageService is
  // assigned the rest is ordered: init's worker messages were posted first and
  // the worker processes messages serially.
  const deadline = Date.now() + 15_000;
  while (!project.service.languageService) {
    if (Date.now() > deadline) throw new Error("mkc language service init timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
  end();
  log.info("local compiler ready", {
    website: project.editor?.website,
    targetVersion: (project.editor?.targetJson as { versions?: { target?: string } })?.versions
      ?.target,
  });

  return {
    compile: async (code, dependencies = { core: "*" }) => {
      // Compile against the editor project's dependencies so extension APIs
      // don't false-fail; mkc resolves bundled packages locally and GitHub
      // extensions via the MakeCode cloud.
      seedPxtJson(dependencies);
      seedFile("prj/main.ts", code);
      // Non-native build: typecheck + JS emit only, no C++ hex downloads.
      const res = await project.buildAsync({});
      return {
        success: !!res.success,
        diagnostics: (res.diagnostics ?? []) as CompilerDiagnostic[],
      };
    },
  };
}

export class LocalCompiler {
  private readonly ensureEngine: () => Promise<CompilerEngine>;
  // Promise-chain mutex: one shared project state, so compiles must not race.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(engineFactory: () => Promise<CompilerEngine> = createMkcEngine) {
    this.ensureEngine = lazyRetry(engineFactory);
  }

  /** Error lines in the shared `main.ts(L,C): error TS####: msg` format.
   *  Never throws: on any internal failure it returns [] so validation
   *  degrades to the old load-and-see behaviour instead of blocking. */
  getDiagnostics(code: string, dependencies?: Record<string, string>): Promise<string[]> {
    const run = this.chain.then(async () => {
      log.group("local compile (pxt-mkc)", true);
      try {
        const engine = await this.ensureEngine();
        const { success, diagnostics } = await engine.compile(code, dependencies);
        // Errors only (pxt DiagnosticCategory.Error === 1); warnings would be noise.
        const lines = diagnostics
          .filter((d) => (d.category ?? 1) === 1)
          .map(formatCompilerDiagnostic);
        log.info("compiled", { success, errors: lines.length, code: preview(code, 200) });
        for (const line of lines) log.info(line);
        return lines;
      } catch (err) {
        log.warn("local compile failed open (no diagnostics attached)", err);
        return [];
      } finally {
        log.groupEnd();
      }
    });
    this.chain = run;
    return run;
  }
}

/** Shared instance: one compiler (one worker, one cached editor) per page. */
export const localCompiler = new LocalCompiler();
