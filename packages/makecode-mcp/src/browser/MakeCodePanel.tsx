import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { MakeCodeFrame } from "@microbit/makecode-embed/react";
import type { MakeCodeFrameDriver } from "@microbit/makecode-embed/vanilla";
import { IframeExecutor } from "./iframe-executor.js";
import { MakeCodeFrameDriverAdapter } from "./frame-driver-adapter.js";
import type { MakeCodeExecutor } from "../shared/types.js";

export interface MakeCodePanelProps {
  onExecutorReady: (executor: MakeCodeExecutor) => void;
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

  const initialProjects = useMemo(() => async () => [], []);

  // Signal readiness on whichever fires first: onEditorContentLoaded (normal
  // browsers) or onWorkspaceLoaded (some headless / Playwright contexts where
  // editorcontentloaded is never dispatched). notifiedRef ensures one call.
  const notifyReady = useCallback(() => {
    const adapter = ensureAdapter();
    if (!adapter || notifiedRef.current) return;
    notifiedRef.current = true;
    onExecutorReady(new IframeExecutor(adapter));
  }, [ensureAdapter, onExecutorReady]);

  const handleEditorContentLoaded = useCallback(() => {
    notifyReady();
  }, [notifyReady]);

  const handleWorkspaceLoaded = useCallback(() => {
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
    return () => {
      adapterRef.current?.dispose();
      driverRef.current = null;
      adapterRef.current = null;
      notifiedRef.current = false;
    };
  }, []);

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
