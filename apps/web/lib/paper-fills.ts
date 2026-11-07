// Simulated fills from paper mode. A signed-in user's fills are saved to the database (POST /api/paper/fills) and
// listed from it (GET). The in-memory list here is only the fallback when a save fails, for example with no
// session or no database, and it is cleared on reload. Every paper fill is labelled as simulated. Client-only.
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getJson, postJson } from "@/lib/api";
import type { Fill, TicketInput } from "@/lib/types";

export const PAPER_FILLS_QUERY_KEY = ["paper-fills"] as const;

let fallback: Fill[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Keeps a paper fill in this page session only. Used when the save to the database fails. */
export function addPaperFill(f: Omit<Fill, "id" | "simulated">): void {
  fallback = [{ ...f, id: `paper_${Date.now()}_${fallback.length}`, simulated: true }, ...fallback].slice(0, 50);
  emit();
}

/** Paper fills kept in this page session only (the fallback). */
export function usePaperFills(): Fill[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => fallback,
    () => fallback,
  );
}

export interface PaperFillDraft {
  side: "buy" | "sell";
  asset: string;
  orderType: TicketInput["orderType"];
  notionalUsd: number;
  priceUsd: number;
  feeUsd: number;
  /** Flash quote id the simulated price came from, when there was one. */
  quoteId?: string;
}

/** Saves a simulated fill for the signed-in wallet. Rejects on failure; the caller then keeps the fallback. */
export function savePaperFill(draft: PaperFillDraft): Promise<{ orderId: string; fillId: string }> {
  return postJson<{ orderId: string; fillId: string }>("/api/paper/fills", draft);
}

interface PaperFillsResponse {
  fills: Fill[];
}

/** The signed-in user's saved paper fills, newest first. Empty when there is no session. */
export function usePaperServerFills(funder: string | null): Fill[] {
  const q = useQuery({
    queryKey: [...PAPER_FILLS_QUERY_KEY, funder],
    queryFn: () => getJson<PaperFillsResponse>("/api/paper/fills"),
    enabled: funder !== null,
  });
  return q.data?.fills ?? [];
}
