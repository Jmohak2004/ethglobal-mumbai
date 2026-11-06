import { NextResponse } from "next/server";

import { quoteTicket } from "@/lib/server/flash";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";
import type { TicketInput } from "@/lib/types";

export const dynamic = "force-dynamic";

const SIDES = ["buy", "sell"] as const;
const ORDER_TYPES = ["market", "limit", "twap", "stop", "trailing", "bracket"] as const;

type Rec = Record<string, unknown>;
const opt = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Validates the ticket shape. Limits (MAX_TRADE_USD, allowlist) are enforced in lib/server/flash.ts. */
function parseTicket(v: unknown): TicketInput {
  if (typeof v !== "object" || v === null) throw new ApiError(422, "VALIDATION", "ticket is required");
  const t = v as Rec;
  const errors: string[] = [];
  if (!(SIDES as readonly unknown[]).includes(t.side)) errors.push("side must be buy or sell");
  if (typeof t.asset !== "string") errors.push("asset is required");
  if (!(ORDER_TYPES as readonly unknown[]).includes(t.orderType)) errors.push("orderType is not supported");
  if (opt(t.sizeUsd) === undefined) errors.push("sizeUsd must be a number");
  if (errors.length > 0) throw new ApiError(422, "VALIDATION", "Invalid ticket", errors);
  const twap = typeof t.twap === "object" && t.twap !== null ? (t.twap as Rec) : undefined;
  const twapMin = opt(twap?.durationMin);
  const twapBuckets = opt(twap?.buckets);
  return {
    side: t.side as TicketInput["side"],
    asset: t.asset as string,
    orderType: t.orderType as TicketInput["orderType"],
    sizeUsd: t.sizeUsd as number,
    limitPrice: opt(t.limitPrice),
    triggerPrice: opt(t.triggerPrice),
    trailPct: opt(t.trailPct),
    twap: twapMin !== undefined && twapBuckets !== undefined ? { durationMin: twapMin, buckets: twapBuckets } : undefined,
    takeProfitPrice: opt(t.takeProfitPrice),
    stopLossPrice: opt(t.stopLossPrice),
  };
}

/**
 * POST { ticket, markPriceUsd }. Requires a wallet session (the session is the funder). Live mode returns
 * signing payloads and onchain steps. Paper mode returns a simulated quote and never a signature request.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as Rec | null;
  const ticket = parseTicket(body?.ticket);
  const markPriceUsd = opt(body?.markPriceUsd);
  if (markPriceUsd === undefined || markPriceUsd <= 0) throw new ApiError(422, "VALIDATION", "markPriceUsd must be positive");
  if (typeof body?.funder === "string" && body.funder.toLowerCase() !== session.address) {
    throw new ApiError(403, "FORBIDDEN", "funder must be the signed-in wallet");
  }
  return NextResponse.json(await quoteTicket({ ticket, funder: session.address, markPriceUsd }));
});
