import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { MakeCodeFrame } from "@microbit/makecode-embed/react";
import {
  defaultMakeCodeProject,
  type MakeCodeFrameDriver,
} from "@microbit/makecode-embed/vanilla";
import { IframeExecutor } from "./iframe-executor.js";
import { MakeCodeFrameDriverAdapter } from "./frame-driver-adapter.js";
import { localCompiler } from "./local-compiler.js";
import { LoadWatchdog } from "./load-watchdog.js";
import type { BrowserExecutor } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("panel");

/** How long to wait for the iframe's first onEditorContentLoaded /
 *  onWorkspaceLoaded before reporting a load failure. */
export const MAKECODE_LOAD_TIMEOUT_MS = 30_000;

export interface MakeCodePanelProps {
  onExecutorReady: (executor: BrowserExecutor) => void;
  /** Called once if the iframe never signals ready within
   *  MAKECODE_LOAD_TIMEOUT_MS. */
  onLoadError?: (reason: string) => void;
  baseUrl?: string;
  controllerId?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function MakeCodePanel({
  onExecutorReady,
  onLoadError,
  baseUrl = "https://makecode.microbit.org",
  controllerId = "makecode-mcp",
  className,
  style,
}: MakeCodePanelProps) {
  const driverRef = useRef<MakeCodeFrameDriver | null>(null);
  const adapterRef = useRef<MakeCodeFrameDriverAdapter | null>(null);
  const notifiedRef = useRef(false);
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;
  const watchdogRef = useRef<LoadWatchdog | null>(null);

  const ensureAdapter = useCallback(() => {
    if (!adapterRef.current && driverRef.current) {
      adapterRef.current = new MakeCodeFrameDriverAdapter(driverRef.current, (code, deps) =>
        localCompiler.getDiagnostics(code, deps),
      );
    }
    return adapterRef.current;
  }, []);

  // Seed with a project we own so the header captured via onWorkspaceSave is
  // one we know. Returning [] makes MakeCode fall back to IndexedDB and a
  // later importProject won't reload the visible editor. defaultMakeCodeProject
  // opens on the standard on-start block.
  const initialProjects = useMemo(
    () => async () => [defaultMakeCodeProject],
    [],
  );

  // Signal readiness on whichever fires first: onEditorContentLoaded (normal
  // browsers) or onWorkspaceLoaded (some headless / Playwright contexts where
  // editorcontentloaded is never dispatched). notifiedRef ensures one call.
  const notifyReady = useCallback(() => {
    const adapter = ensureAdapter();
    if (!adapter || notifiedRef.current) return;
    notifiedRef.current = true;
    watchdogRef.current?.notifyReady();
    log.info("iframe ready → handing executor to host app");
    onExecutorReady(new IframeExecutor(adapter));
  }, [ensureAdapter, onExecutorReady]);

  const handleEditorContentLoaded = useCallback(() => {
    log.debug("onEditorContentLoaded");
    notifyReady();
  }, [notifyReady]);

  const handleWorkspaceLoaded = useCallback(() => {
    log.debug("onWorkspaceLoaded");
    notifyReady();
  }, [notifyReady]);

  const handleWorkspaceSave = useCallback(
    (event: Parameters<NonNullable<React.ComponentProps<typeof MakeCodeFrame>["onWorkspaceSave"]>>[0]) => {
      ensureAdapter()?.handleWorkspaceSave(event);
    },
    [ensureAdapter],
  );

  const handleDownload = useCallback(
    (download: { name: string; hex: string }) => {
      ensureAdapter()?.handleDownload(download);
    },
    [ensureAdapter],
  );

  useEffect(() => {
    log.info("mounting MakeCodePanel", { baseUrl, controllerId });
    const watchdog = new LoadWatchdog(MAKECODE_LOAD_TIMEOUT_MS, (reason) => {
      log.warn("iframe load watchdog tripped", { reason });
      onLoadErrorRef.current?.(reason);
    });
    watchdogRef.current = watchdog;
    watchdog.start();
    return () => {
      log.info("unmounting MakeCodePanel → disposing adapter");
      watchdog.dispose();
      watchdogRef.current = null;
      adapterRef.current?.dispose();
      driverRef.current = null;
      adapterRef.current = null;
      notifiedRef.current = false;
    };
  }, [baseUrl, controllerId]);

  return (
    <MakeCodeFrame
      ref={(d: MakeCodeFrameDriver | null) => {
        driverRef.current = d;
      }}
      baseUrl={baseUrl}
      controller={2}
      controllerId={controllerId}
      initialProjects={initialProjects}
      onEditorContentLoaded={handleEditorContentLoaded}
      onWorkspaceLoaded={handleWorkspaceLoaded}
      onWorkspaceSave={handleWorkspaceSave}
      onDownload={handleDownload}
      className={className}
      style={style}
      allow="usb; serial"
    />
  );
}

export default MakeCodePanel;
