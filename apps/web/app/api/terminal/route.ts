import { NextResponse } from "next/server";

import { getTradingActivity } from "@/lib/data";
import { route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** Open orders, fills and balances for the trade terminal (demo data without a database). */
export const GET = route(async (req: Request) => {
  const address = new URL(req.url).searchParams.get("address") ?? undefined;
  return NextResponse.json(await getTradingActivity(address));
});
