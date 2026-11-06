import { NextResponse } from "next/server";

import { getLeaderboard, parseLeaderboardQuery } from "@/lib/data";

export const dynamic = "force-dynamic";

/** GET /api/leaderboard?kind=agent|human|all&template=&timeframe=24h|7d|30d|all&mode=live|paper|all */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const rows = await getLeaderboard(parseLeaderboardQuery(params));
  return NextResponse.json(rows);
}
