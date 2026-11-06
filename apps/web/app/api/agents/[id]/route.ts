import { NextResponse } from "next/server";

import { getAgent, hasForkLicense, toPublicAgent } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";
import { getSession } from "@/lib/server/session";
import type { AgentView } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Agent record. Everyone gets the stats-only projection (PRD 6.1). `config` (sliders, sources, lessons, limits) is
 * added only for the owner session or a buyer with a recorded fork of this agent.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");

  const session = getSession(req);
  const base = toPublicAgent(agent);
  let view: AgentView = { ...base, viewer: "public" };
  if (session && session.address === agent.ownerAddress.toLowerCase()) {
    view = { ...base, viewer: "owner", config: agent.config };
  } else if (session && (await hasForkLicense(agent.id, session.address))) {
    view = { ...base, viewer: "licensee", config: agent.config };
  }
  return NextResponse.json(view);
});
