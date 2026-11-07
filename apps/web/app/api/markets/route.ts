import { NextResponse } from "next/server";

import { route } from "@/lib/server/errors";
import { loadStatsForAssets, tradeAssets } from "@/lib/server/market";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets. 24h stats (last, open, high, low, volume) for every platform asset with a Coinbase product,
 * in ALLOWED_TOKENS order. Each product is cached for 15 s, with at most 4 upstream requests in flight.
 * Assets that fail upstream are omitted and listed in `unavailable`. Responds 502 only when none succeed.
 */
export const GET = route(async () => {
  return NextResponse.json(await loadStatsForAssets(tradeAssets()));
});
