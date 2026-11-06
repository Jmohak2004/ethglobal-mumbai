import { NextResponse } from "next/server";

import { getAgent, getPaperLedger } from "@/lib/data";
import { ApiError, route } from "@/lib/server/errors";
import { assertOwnerAccess } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Paper self-funding ledger (commission, top-ups, totals). Owner only. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  assertOwnerAccess(req, agent.ownerAddress, { demo: new URL(req.url).searchParams.get("owner") === "1" });
  return NextResponse.json(await getPaperLedger(agent));
});
