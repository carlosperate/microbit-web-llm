import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { MakeCodeFrame } from "@microbit/makecode-embed/react";
import {
  defaultMakeCodeProject,
  type MakeCodeFrameDriver,
} from "@microbit/makecode-embed/vanilla";
import { IframeExecutor } from "./iframe-executor.js";
import { MakeCodeFrameDriverAdapter } from "./frame-driver-adapter.js";
import type { BrowserExecutor } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("panel");

export interface MakeCodePanelProps {
  onExecutorReady: (executor: BrowserExecutor) => void;
  baseUrl?: string;
  controllerId?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function MakeCodePanel({
  onExecutorReady,
  baseUrl = "https://makecode.microbit.org",
  controllerId = "makecode-mcp",
  className,
  style,
}: MakeCodePanelProps) {
  const driverRef = useRef<MakeCodeFrameDriver | null>(null);
  const adapterRef = useRef<MakeCodeFrameDriverAdapter | null>(null);
  const notifiedRef = useRef(false);

  const ensureAdapter = useCallback(() => {
    if (!adapterRef.current && driverRef.current) {
      adapterRef.current = new MakeCodeFrameDriverAdapter(driverRef.current);
    }
    return adapterRef.current;
  }, []);

  // Seed the iframe with a project *we* own so the workspace header captured
  // via onWorkspaceSave is one we know. Returning [] here causes MakeCode to
  // fall back to whatever's in IndexedDB (or the home screen), and a later
  // importProject writes to the workspace but doesn't reload the visible editor.
  // Use makecode-embed's defaultMakeCodeProject so the editor opens on the
  // standard on-start block instead of a blank workspace.
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
    return () => {
      log.info("unmounting MakeCodePanel → disposing adapter");
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
