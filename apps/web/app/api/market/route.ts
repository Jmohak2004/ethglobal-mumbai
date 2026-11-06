import { NextResponse } from "next/server";

import { getMarket } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** GET /api/market?asset=WETH|cbBTC. Candles plus indicators for one allowlisted asset. */
export const GET = route(async (req: Request) => {
  const asset = new URL(req.url).searchParams.get("asset") ?? "WETH";
  const market = await getMarket(asset);
  if (!market) throw new ApiError(404, "NOT_FOUND", `Unknown asset ${asset}`);
  return NextResponse.json(market);
});
