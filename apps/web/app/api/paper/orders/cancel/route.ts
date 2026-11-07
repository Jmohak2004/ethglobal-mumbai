import { NextResponse } from "next/server";

import { dbContext } from "@/lib/server/db";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Paper order ids: local labels or "paper_<uuid>". Never Flash ids. */
const PAPER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IDS = 25;

function parseIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_IDS) {
    throw new ApiError(422, "VALIDATION", `orderIds must be an array of 1 to ${MAX_IDS} ids`);
  }
  const ids = v.map((x: unknown) => {
    if (typeof x !== "string" || !PAPER_ID.test(x)) throw new ApiError(422, "VALIDATION", "orderIds are invalid");
    return x;
  });
  if (new Set(ids).size !== ids.length) throw new ApiError(422, "VALIDATION", "orderIds must be unique");
  return ids;
}

/**
 * POST { orderIds }. Marks the signed-in user's open paper orders as cancelled in the database. Ids that are not
 * the user's open paper orders (for example demo rows) are ignored. Nothing is sent to Flash.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as { orderIds?: unknown } | null;
  const orderIds = parseIds(body?.orderIds);
  const ctx = await dbContext();
  if (!ctx) return NextResponse.json({ cancelled: [] });
  const cancelled = await ctx.r.cancelPaperOrders(ctx.db, session.address, orderIds);
  return NextResponse.json({ cancelled });
});
