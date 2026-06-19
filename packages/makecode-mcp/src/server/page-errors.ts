// True when a cached page/frame is permanently gone (tab discarded, renderer
// recycled, window closed). Matches on message, not `instanceof`/`.code`,
// because `page.evaluate` on a dead frame throws a *plain* Error: verified on
// Puppeteer 23.x, none are `PuppeteerError`/`TargetCloseError` and
// `isTargetClosedError()` is false. page-errors.puppeteer.test.ts pins the
// wording against a real browser so a version bump that changes it fails loudly.
const DEAD_PAGE_RE =
  /detached frame|target closed|session closed|execution context was destroyed|frame (?:was )?detached|page has been closed|attempted to use detached/i;

export function isDeadPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return DEAD_PAGE_RE.test(msg);
}
