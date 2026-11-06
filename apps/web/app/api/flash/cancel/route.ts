import { NextResponse } from "next/server";

import { parseCancelIds, planCancel } from "@/lib/server/flash";
import { flashLive } from "@/lib/server/env";
import { readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * POST { orderIds }. Returns the cancel plan. Paper mode: nothing is sent to Flash and no signature is needed.
 * Live mode: returns the exact cancel message for the signed-in funder to sign, then POST /api/flash/cancel/submit.
 */
export const POST = route(async (req: Request) => {
  const live = flashLive();
  if (live) requireSession(req);
  const body = (await readJson(req)) as { orderIds?: unknown } | null;
  const orderIds = parseCancelIds(body?.orderIds, live);
  return NextResponse.json(planCancel(orderIds));
});
