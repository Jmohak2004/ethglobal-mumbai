import { NextResponse } from "next/server";

import { getTrades } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** GET /api/trades?limit=100&agentId=&cursor= : public feed of every fill, newest first (limit max 200). */
export const GET = route(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const rawLimit = sp.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isFinite(limit) || limit < 1) throw new ApiError(422, "VALIDATION", "limit must be a positive number");
  const res = await getTrades({
    limit: Math.min(Math.floor(limit), 200),
    agentId: sp.get("agentId") || undefined,
    cursor: sp.get("cursor") || undefined,
  });
  return NextResponse.json(res, { headers: { "Cache-Control": "no-store" } });
});
