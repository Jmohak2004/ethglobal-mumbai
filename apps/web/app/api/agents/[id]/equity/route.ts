import { NextResponse } from "next/server";

import { getAgentEquityCurve } from "@/lib/data";
import { route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** Aggregate equity curve (stats-level, public). */
export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return NextResponse.json(await getAgentEquityCurve(id));
});
