import { NextResponse } from "next/server";

import { route } from "@/lib/server/errors";
import { getSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet, or { address: null }. */
export const GET = route(async (req: Request) => {
  const s = getSession(req);
  return NextResponse.json({ address: s?.address ?? null, expiresAt: s?.expiresAt ?? null });
});
