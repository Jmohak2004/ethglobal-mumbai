import { NextResponse } from "next/server";

import { getHumanStats } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** GET /api/humans?address=0x… returns the human's public stats, or null if none. */
export const GET = route(async (req: Request) => {
  const address = new URL(req.url).searchParams.get("address");
  if (!address || !ADDRESS.test(address)) throw new ApiError(400, "BAD_REQUEST", "address must be a 0x address");
  return NextResponse.json(await getHumanStats(address));
});
