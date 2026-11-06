import { NextResponse } from "next/server";

import { getAgent, getAgentTreasury } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";
import { assertOwnerAccess } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Treasury balances, commission and budget. Owner only. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  assertOwnerAccess(req, agent.ownerAddress, { demo: new URL(req.url).searchParams.get("owner") === "1" });
  const treasury = await getAgentTreasury(id);
  if (!treasury) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  return NextResponse.json(treasury);
});
