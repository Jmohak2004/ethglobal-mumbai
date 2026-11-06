// Paper-mode order cancels. Nothing reaches Flash: a cancel only marks the row locally for this page session, and
// the row is labelled as simulated. Client-only.
import { useSyncExternalStore } from "react";

let cancelled: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function markPaperOrdersCancelled(ids: readonly string[]): void {
  cancelled = new Set([...cancelled, ...ids]);
  for (const l of listeners) l();
}

export function usePaperCancelledOrders(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cancelled,
    () => cancelled,
  );
}
