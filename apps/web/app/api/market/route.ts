import { NextResponse } from "next/server";

import { getMarket } from "@/lib/data";

export const dynamic = "force-dynamic";

/** GET /api/market?asset=WETH|cbBTC. Candles plus indicators for one allowlisted asset. */
export async function GET(req: Request) {
  const asset = new URL(req.url).searchParams.get("asset") ?? "WETH";
  const market = await getMarket(asset);
  if (!market) return NextResponse.json({ error: `unknown asset ${asset}` }, { status: 404 });
  return NextResponse.json(market);
}
