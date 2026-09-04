import { SIM_URL_PLACEHOLDER, WORKER_URL_PLACEHOLDER } from "../shared/makecode-mirror-contract.js";

// Hosts that forbid framing third-party origins still allow `blob:`, and a blob
// frame is a real iframe — which is the only thing MakeCode checks before it
// will enter controller mode. So the view mints the editor, its simulator and
// its compiler worker as blobs of pages our own server mirrors.
export interface BlobBootDeps {
  fetchText(path: string): Promise<string>;
  createObjectURL(text: string, type: string): string;
}

/** Returns the `src` for the editor iframe. */
export async function buildMakeCodeBlobUrl(deps: BlobBootDeps): Promise<string> {
  // Order matters: the editor document has to name the other two.
  const [simHtml, workerJs] = await Promise.all([
    deps.fetchText("/mk/simulator.html"),
    deps.fetchText("/mk/worker.js"),
  ]);
  const simUrl = deps.createObjectURL(simHtml, "text/html");
  const workerUrl = deps.createObjectURL(workerJs, "application/javascript");

  const editorHtml = (await deps.fetchText("/mk/editor.html"))
    .split(SIM_URL_PLACEHOLDER)
    .join(simUrl)
    .split(WORKER_URL_PLACEHOLDER)
    .join(workerUrl);

  // A blob URL takes no query string, and pxt's mode check scans the whole href.
  return `${deps.createObjectURL(editorHtml, "text/html")}#controller=2`;
}

/** Browser wiring for {@link buildMakeCodeBlobUrl}. */
export function browserBlobBoot(serverOrigin: string): BlobBootDeps {
  return {
    fetchText: async (path) => {
      const res = await fetch(`${serverOrigin}${path}`);
      if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
      return await res.text();
    },
    createObjectURL: (text, type) => URL.createObjectURL(new Blob([text], { type })),
  };
}
