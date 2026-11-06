import { NextResponse } from "next/server";

import { flashActivity } from "@/lib/server/flash";
import { flashLive } from "@/lib/server/env";
import { ApiError, route } from "@/lib/server/errors";
import { assertOwnerAccess } from "@/lib/server/session";
import type { TradingActivity } from "@/lib/types";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET ?funder=0x…. Open orders, fills and balances for the signed-in wallet. Empty when Flash is not live
 * (paper mode). Polled by the trade terminal.
 */
export const GET = route(async (req: Request) => {
  const funder = new URL(req.url).searchParams.get("funder");
  if (!funder || !ADDRESS.test(funder)) throw new ApiError(400, "BAD_REQUEST", "funder must be a 0x address");
  assertOwnerAccess(req, funder);
  if (!flashLive()) {
    const idle: TradingActivity = { source: "none", openOrders: [], fills: [], balances: [] };
    return NextResponse.json({ ...idle, live: false });
  }
  return NextResponse.json({ ...(await flashActivity(funder as `0x${string}`)), live: true });
});
