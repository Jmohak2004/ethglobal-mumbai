import { NextResponse } from "next/server";

import { ApiError, route } from "@/lib/server/errors";
import { DEFAULT_GRANULARITY, GRANULARITIES, isGranularity, isTradeAsset, loadMarket } from "@/lib/server/market";

export const dynamic = "force-dynamic";

/**
 * GET /api/market?asset=<ticker>&granularity=300. Any ticker with a Coinbase product (WETH, cbBTC, AERO, ...).
 * granularity is one of 60, 300, 900, 3600, 21600, 86400 (seconds). Public Coinbase candles (ascending) with last
 * price and 24h stats. Cache: 10 s for 1m, 15 s for 5m, 30 s for longer intervals.
 */
export const GET = route(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const asset = sp.get("asset") ?? "WETH";
  if (!isTradeAsset(asset)) throw new ApiError(404, "NOT_FOUND", `Unknown asset ${asset}`);
  const granularity = sp.get("granularity") === null ? DEFAULT_GRANULARITY : Number(sp.get("granularity"));
  if (!isGranularity(granularity)) {
    throw new ApiError(422, "VALIDATION", `granularity must be one of ${GRANULARITIES.join(", ")}`);
  }
  return NextResponse.json(await loadMarket(asset, granularity));
});
