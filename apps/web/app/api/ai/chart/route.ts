import { NextResponse } from "next/server";

import { analyzeChart } from "@arena/zerog";

import { dbContext } from "@/lib/server/db";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { zgCaller, zgError } from "@/lib/server/zerog";
import { getSession } from "@/lib/server/session";
import type { ChartReadResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_IMAGE_CHARS = 3_000_000;

/**
 * POST { image: data URL, asset? }. Vision read of a chart screenshot via 0G (qwen3-vl-plus). Uses the
 * caller's own 0G key when x-user-0g-key is set (billed to them), otherwise the platform key (sign-in required).
 */
export const POST = route(async (req: Request) => {
  const body = (await readJson(req)) as { image?: unknown; asset?: unknown } | null;
  if (typeof body?.image !== "string" || !body.image.startsWith("data:image/")) {
    throw new ApiError(422, "VALIDATION", "image must be a data:image/... URL");
  }
  if (body.image.length > MAX_IMAGE_CHARS) throw new ApiError(413, "VALIDATION", "Image is too large (max about 2 MB)");
  const asset = typeof body.asset === "string" ? body.asset.slice(0, 16) : undefined;

  const { router, payer } = zgCaller(req);
  let result;
  try {
    result = await analyzeChart(router, { image: body.image, asset });
  } catch (err) {
    throw zgError(err);
  }

  const ctx = await dbContext();
  if (ctx) {
    await ctx.r
      .insertInference(ctx.db, result.trace, { purpose: "vision", userAddress: getSession(req)?.address ?? null })
      .catch((err: unknown) => console.warn("[arena] inference log failed:", (err as Error).message));
  }

  const out: ChartReadResult = {
    trend: result.trend,
    keyLevels: result.keyLevels,
    suggestedTemplate: result.suggestedTemplate,
    suggestedSliders: result.suggestedSliders,
    summary: result.summary,
    requestId: result.trace.requestId,
    payer,
    teeVerified: result.trace.teeVerified,
  };
  return NextResponse.json(out);
});
