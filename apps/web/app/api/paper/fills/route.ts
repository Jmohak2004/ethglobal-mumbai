import { NextResponse } from "next/server";

import { dbContext, type PaperFillInput, type PaperFillRow } from "@/lib/server/db";
import { env, flashLive } from "@/lib/server/env";
import { consumePaperQuote } from "@/lib/server/flash";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";
import type { Fill } from "@/lib/types";

export const dynamic = "force-dynamic";

type Rec = Record<string, unknown>;

const SIDES = ["buy", "sell"] as const;
/** Terminal order types to the Flash order type stored on the row (the same names flash.ts maps to). */
const ORDER_TYPES = new Map<string, PaperFillInput["orderType"]>([
  ["market", "market"],
  ["limit", "limit"],
  ["twap", "twap"],
  ["stop", "stop"],
  ["trailing", "trailing-stop"],
  ["bracket", "bracket"],
]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Validates the shape of a paper fill. Limits and the allowlist are checked by assertPaperLimits. */
function parsePaperFill(v: unknown): Omit<PaperFillInput, "funderAddress" | "integratorFeeUsd"> {
  if (typeof v !== "object" || v === null) throw new ApiError(422, "VALIDATION", "body is required");
  const b = v as Rec;
  const errors: string[] = [];
  if (!(SIDES as readonly unknown[]).includes(b.side)) errors.push("side must be buy or sell");
  if (typeof b.asset !== "string" || b.asset.length === 0 || b.asset.length > 16) errors.push("asset is required");
  const orderType = typeof b.orderType === "string" ? ORDER_TYPES.get(b.orderType) : undefined;
  if (!orderType) errors.push("orderType is not supported");
  const notionalUsd = num(b.notionalUsd);
  if (notionalUsd === undefined || notionalUsd <= 0) errors.push("notionalUsd must be a positive number");
  const priceUsd = num(b.priceUsd);
  if (priceUsd === undefined || priceUsd <= 0) errors.push("priceUsd must be a positive number");
  const feeUsd = num(b.feeUsd);
  if (feeUsd === undefined || feeUsd < 0) errors.push("feeUsd must be zero or positive");
  if (b.quoteId !== undefined && b.quoteId !== null && (typeof b.quoteId !== "string" || b.quoteId.length > 128)) {
    errors.push("quoteId must be a string of at most 128 characters");
  }
  if (errors.length > 0 || !orderType || notionalUsd === undefined || priceUsd === undefined || feeUsd === undefined) {
    throw new ApiError(422, "VALIDATION", "Invalid paper fill", errors);
  }
  return {
    side: b.side as PaperFillInput["side"],
    asset: b.asset as string,
    orderType,
    notionalUsd,
    priceUsd,
    feeUsd,
    quoteId: typeof b.quoteId === "string" ? b.quoteId : null,
  };
}

/**
 * Same limits as the Flash ticket (lib/server/flash.ts assertTicketLimits): MIN_ORDER_USD, MAX_TRADE_USD and the
 * allowlist. Also requires the fee to cover at least the integrator fee, which every paper quote includes.
 */
function assertPaperLimits(input: { notionalUsd: number; asset: string; feeUsd: number }, integratorFeeUsd: number): void {
  const e = env();
  if (!(input.notionalUsd >= e.MIN_ORDER_USD) || input.notionalUsd > e.MAX_TRADE_USD) {
    throw new ApiError(
      422,
      "VALIDATION",
      `Size must be between $${e.MIN_ORDER_USD} (MIN_ORDER_USD) and $${e.MAX_TRADE_USD} (MAX_TRADE_USD)`,
    );
  }
  if (!e.ALLOWED_TOKENS.includes(input.asset)) throw new ApiError(422, "VALIDATION", `${input.asset} is not on the platform allowlist`);
  if (input.feeUsd + 1e-9 < integratorFeeUsd) throw new ApiError(422, "VALIDATION", "feeUsd is below the integrator fee");
}

function toFill(r: PaperFillRow): Fill {
  return {
    id: r.id,
    ts: r.ts,
    asset: r.asset,
    side: r.side,
    sizeUsd: r.notionalUsd,
    priceUsd: r.price,
    feeUsd: r.feeUsd,
    txHash: null,
    simulated: true,
  };
}

/**
 * GET. The signed-in user's paper fills, newest first. Empty when no database is configured.
 */
export const GET = route(async (req: Request) => {
  const session = requireSession(req);
  const ctx = await dbContext();
  if (!ctx) return NextResponse.json({ fills: [] });
  const rows = await ctx.r.listPaperFillsByFunder(ctx.db, session.address, 100);
  return NextResponse.json({ fills: rows.map(toFill) });
});

/**
 * POST { side, asset, orderType, notionalUsd, priceUsd, feeUsd, quoteId? }. Records a simulated fill for the
 * signed-in wallet as an agentless order and fill. Nothing is sent to Flash. Live mode refuses, so paper fills
 * never mix into live stats.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  if (flashLive()) throw new ApiError(409, "UNAVAILABLE", "Live mode: paper fills are not recorded");
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (typeof body?.quoteId !== "string") {
    throw new ApiError(422, "VALIDATION", "quoteId from a server paper quote is required");
  }
  // Price, size and fee come from the quote the server issued, never from the client, so the Humans board
  // can't be inflated with made-up fills.
  const q = consumePaperQuote(body.quoteId, session.address);
  const input = parsePaperFill({ ...q, quoteId: body.quoteId });
  const integratorFeeUsd = (input.notionalUsd * env().FLASH_INTEGRATOR_FEE_BPS) / 10_000;
  assertPaperLimits({ notionalUsd: input.notionalUsd, asset: input.asset, feeUsd: input.feeUsd }, integratorFeeUsd);

  const ctx = await dbContext();
  if (!ctx) throw new ApiError(503, "UNAVAILABLE", "Database is not configured. The fill is kept in this browser only.");
  const stored = await ctx.r.insertPaperFill(ctx.db, { ...input, funderAddress: session.address, integratorFeeUsd });
  return NextResponse.json(stored, { status: 201 });
});
