import { NextResponse } from "next/server";

import { getLeaderboard, parseLeaderboardQuery } from "@/lib/data";
import { route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** GET /api/leaderboard?kind=agent|human|all&template=&timeframe=24h|7d|30d|all&mode=live|paper|all */
export const GET = route(async (req: Request) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return NextResponse.json(await getLeaderboard(parseLeaderboardQuery(params)));
});
