import { NextResponse } from "next/server";

import { getAgent, getAgentLessons } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";
import { assertOwnerAccess } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Reflection lessons. Owner only. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  assertOwnerAccess(req, agent.ownerAddress, { demo: new URL(req.url).searchParams.get("owner") === "1" });
  return NextResponse.json(await getAgentLessons(id));
});
