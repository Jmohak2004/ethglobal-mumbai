import { NextResponse } from "next/server";

import { getTradingActivity } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Open orders, fills and balances for the trade terminal bottom panel. */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? undefined;
  return NextResponse.json(await getTradingActivity(address));
}
