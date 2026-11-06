import { NextResponse } from "next/server";

import { getAgent } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** Public agent record. Owner-only data lives under sub-routes. */
export const GET = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  return NextResponse.json(agent);
});
