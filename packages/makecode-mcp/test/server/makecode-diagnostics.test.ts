import { describe, it, expect } from "vitest";
import {
  parseDiagnostics,
  MakeCodeDiagnostics,
} from "../../src/server/makecode-diagnostics.ts";

// Real console output captured from makecode.microbit.org for the user's
// example (the editor logs all TS errors as one multi-line console.log).
const REAL =
  "error: main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?\n" +
  "error: main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.\n";

describe("parseDiagnostics", () => {
  it("extracts each TS error line and strips the leading 'error: ' prefix", () => {
    expect(parseDiagnostics(REAL)).toEqual([
      "main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?",
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
  });

  it("ignores console noise that isn't a TS diagnostic", () => {
    expect(parseDiagnostics("[mkcp:panel] onEditorContentLoaded")).toEqual([]);
    expect(parseDiagnostics("loading https://makecode.microbit.org")).toEqual([]);
  });

  it("dedupes repeated identical diagnostics", () => {
    expect(parseDiagnostics(REAL + REAL)).toEqual([
      "main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?",
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
  });
});

describe("MakeCodeDiagnostics", () => {
  it("returns the most recent ingested diagnostics within the window", () => {
    let now = 1000;
    const d = new MakeCodeDiagnostics({ now: () => now });
    d.ingest("noise");
    d.ingest(REAL);
    expect(d.recent(5000)).toEqual([
      "main.ts(2,23): error TS2552: Cannot find name 'button'. Did you mean 'Button'?",
      "main.ts(5,1): error TS2304: Cannot find name 'accelermeter'.",
    ]);
  });

  it("returns [] once the latest diagnostics fall outside the window", () => {
    let now = 1000;
    const d = new MakeCodeDiagnostics({ now: () => now });
    d.ingest(REAL);
    now = 1000 + 6000;
    expect(d.recent(5000)).toEqual([]);
  });

  it("returns [] when nothing diagnostic has been ingested", () => {
    const d = new MakeCodeDiagnostics();
    d.ingest("just some logs");
    expect(d.recent(5000)).toEqual([]);
  });

  it("a newer compile replaces the previous diagnostics", () => {
    let now = 1000;
    const d = new MakeCodeDiagnostics({ now: () => now });
    d.ingest(REAL);
    now += 100;
    d.ingest("error: main.ts(1,1): error TS1005: ';' expected.\n");
    expect(d.recent(5000)).toEqual(["main.ts(1,1): error TS1005: ';' expected."]);
  });
});
