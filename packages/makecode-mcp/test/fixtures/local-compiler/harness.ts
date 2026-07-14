// Browser harness for the gated real-network test: exposes the local
// compiler to page.evaluate.
import { localCompiler } from "../../../src/browser/local-compiler.ts";

(window as unknown as { __getDiagnostics: (code: string) => Promise<string[]> }).__getDiagnostics =
  (code) => localCompiler.getDiagnostics(code);
