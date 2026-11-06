// Simulated fills from paper mode. Kept in memory for the page session only, and always labelled as simulated.
// Client-only.
import { useSyncExternalStore } from "react";

import type { Fill } from "@/lib/types";

let fills: Fill[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function addPaperFill(f: Omit<Fill, "id" | "simulated">): void {
  fills = [{ ...f, id: `paper_${Date.now()}_${fills.length}`, simulated: true }, ...fills].slice(0, 50);
  emit();
}

export function usePaperFills(): Fill[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => fills,
    () => fills,
  );
}
