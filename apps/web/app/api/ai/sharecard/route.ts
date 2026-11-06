import { NextResponse } from "next/server";

import { generateShareCard } from "@arena/zerog";

import { dbContext } from "@/lib/server/db";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { getSession } from "@/lib/server/session";
import { zgCaller, zgError } from "@/lib/server/zerog";
import type { ShareCardResult } from "@/lib/types";
import { TEMPLATE_INDEX } from "@/lib/templates";

export const dynamic = "force-dynamic";

/**
 * POST stats-only share card (PRD 6.9). No trade details go into the prompt. The client falls back to the
 * static card when this route answers with an error.
 */
export const POST = route(async (req: Request) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 32) : "";
  const pnlPct = num(body?.pnlPct);
  const winRateBps = num(body?.winRateBps);
  const rank = num(body?.rank) ?? 0;
  const template = typeof body?.template === "string" && body.template in TEMPLATE_INDEX ? body.template : null;
  if (!name || pnlPct === null || winRateBps === null || !template) {
    throw new ApiError(422, "VALIDATION", "name, pnlPct, winRateBps and template are required");
  }

  const { router, payer } = zgCaller(req);
  let result;
  try {
    result = await generateShareCard(router, {
      name,
      pnlPct,
      winRateBps,
      rank,
      template: template as keyof typeof TEMPLATE_INDEX,
      verified: body?.verified === true,
    });
  } catch (err) {
    throw zgError(err);
  }

  const ctx = await dbContext();
  if (ctx) {
    await ctx.r.insertInference(ctx.db, result.trace, { purpose: "share", userAddress: getSession(req)?.address ?? null }).catch(
      (err: unknown) => console.warn("[arena] inference log failed:", (err as Error).message),
    );
  }

  const b64 = result.b64OrUrl;
  const image = /^https?:\/\//.test(b64) ? b64 : `data:${b64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${b64}`;
  const out: ShareCardResult = { image, requestId: result.trace.requestId, payer };
  return NextResponse.json(out);
});
