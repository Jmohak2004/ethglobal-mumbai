import { NextResponse } from "next/server";

import { ApiError, route } from "@/lib/server/errors";
import { DEFAULT_GRANULARITY, GRANULARITIES, isGranularity, isTradeAsset, loadMarket } from "@/lib/server/market";

export const dynamic = "force-dynamic";

/**
 * GET /api/market?asset=WETH|cbBTC&granularity=300. Public Coinbase candles (ascending) with last price and 24h
 * change. Cached for 30 s on the server.
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
