import { NextResponse } from "next/server";

import { getAgent, requestAgentTick } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";
import { getSession, assertOwnerAccess } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * "Run now": queues one tick for the worker (it claims requests every 3 s). Owner only. The agent must be active,
 * and only one request may be queued at a time.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  const sp = new URL(req.url).searchParams;
  assertOwnerAccess(req, agent.ownerAddress, { demo: sp.get("owner") === "1" || sp.get("demo") === "1" });

  if (agent.status === "stopped") throw new ApiError(409, "CONFLICT", "A stopped agent cannot run a decision");
  if (agent.status === "paused") throw new ApiError(409, "CONFLICT", "Resume the agent before running a decision");

  const { requestId } = await requestAgentTick(agent, getSession(req)?.address ?? null);
  return NextResponse.json({ requestId, queued: true }, { status: 202 });
});
