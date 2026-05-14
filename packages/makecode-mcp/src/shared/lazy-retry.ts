// Memoise an async initialiser, but clear the cache on rejection so a
// transient first-call failure doesn't wedge every future caller against the
// same rejected promise.
export function lazyRetry<T>(init: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached) return cached;
    const p = init().catch((err) => {
      if (cached === p) cached = null;
      throw err;
    });
    cached = p;
    return cached;
  };
}
