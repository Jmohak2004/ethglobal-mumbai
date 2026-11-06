import { NextResponse } from "next/server";

import { getAgent, setAgentStatus, toPublicAgent } from "@/lib/data";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { assertOwnerAccess } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const SETTABLE = ["active", "paused"] as const;

/**
 * POST { status: "active" | "paused" }. Owner only (session address == agent owner; ?owner=1 or ?demo=1 is the demo
 * override outside production). Stopped agents are terminal and cannot be resumed.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  const sp = new URL(req.url).searchParams;
  assertOwnerAccess(req, agent.ownerAddress, { demo: sp.get("owner") === "1" || sp.get("demo") === "1" });

  const body = (await readJson(req)) as { status?: unknown } | null;
  const status = body?.status;
  if (typeof status !== "string" || !(SETTABLE as readonly string[]).includes(status)) {
    throw new ApiError(422, "VALIDATION", "status must be \"active\" or \"paused\"");
  }
  if (agent.status === "stopped") throw new ApiError(409, "CONFLICT", "A stopped agent cannot be changed");

  const updated = await setAgentStatus(id, status as (typeof SETTABLE)[number]);
  if (!updated) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  return NextResponse.json(toPublicAgent(updated));
});
