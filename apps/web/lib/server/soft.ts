// Resilient reads for layout-level data. Server-only.
// A layout that awaits the database must never take the whole page down: this wraps the read in a timeout,
// returns a fallback on any failure, and logs the first failure per label (not on every request).

const logged = new Set<string>();

/** Resolves with fn()'s value, or with `fallback` if fn throws or does not settle within `timeoutMs`. */
export async function softRead<T>(label: string, fn: () => Promise<T>, fallback: T, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    if (!logged.has(label)) {
      logged.add(label);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[arena] ${label} unavailable, rendering fallback: ${reason}`);
    }
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
