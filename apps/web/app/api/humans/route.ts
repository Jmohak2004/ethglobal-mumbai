import { NextResponse } from "next/server";

import { getHumanStats } from "@/lib/data";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** GET /api/humans?address=0x… returns the human's public stats, or null if none. */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address");
  if (!address || !ADDRESS.test(address)) {
    return NextResponse.json({ error: "address must be a 0x address" }, { status: 400 });
  }
  return NextResponse.json(await getHumanStats(address));
}
