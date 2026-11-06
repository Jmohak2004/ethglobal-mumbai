import { NextResponse } from "next/server";

import type { RiskLevel } from "@arena/shared";

import { setDemoRisk } from "@/lib/data";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { demoControlsEnabled } from "@/lib/server/env";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const LEVELS: readonly RiskLevel[] = ["NORMAL", "CAUTION", "HALT"];

/**
 * POST { level: "NORMAL" | "CAUTION" | "HALT" }. Demo only: 404 unless DEMO_CONTROLS=true on the server, and a
 * signed-in session is required. Inserts a risk_states row, which the nav pill and the worker read.
 */
export const POST = route(async (req: Request) => {
  if (!demoControlsEnabled()) throw new ApiError(404, "NOT_FOUND", "Not found");
  requireSession(req);
  const body = (await readJson(req)) as { level?: unknown } | null;
  const level = body?.level;
  if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) {
    throw new ApiError(422, "VALIDATION", "level must be NORMAL, CAUTION or HALT");
  }
  return NextResponse.json(await setDemoRisk(level as RiskLevel), { status: 201 });
});
