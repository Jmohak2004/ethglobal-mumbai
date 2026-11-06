import { NextResponse } from "next/server";

import { getAgent, getAgentRuntimeSnapshot } from "@/lib/data";
import { toRuntimeView } from "@/lib/runtime";
import { ApiError, route } from "@/lib/server/errors";
import { isOwnerRequest } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Agent runtime status (worker-written). Polled every 5 s by the status strip. Anyone gets status only: last
 * decision, next decision, outcome, wallet, and whether the worker looks offline. The owner also gets the paper
 * portfolio, the last error, the last request id and the queue flag.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  const sp = new URL(req.url).searchParams;
  const owner = isOwnerRequest(req, agent.ownerAddress, { demo: sp.get("owner") === "1" });
  const snap = await getAgentRuntimeSnapshot(agent);
  return NextResponse.json(
    toRuntimeView({
      runtime: snap.runtime,
      walletProvisioned: snap.walletProvisioned,
      tickQueued: snap.tickQueued,
      tickIntervalSec: agent.config.tickIntervalSec,
      viewer: owner ? "owner" : "public",
      now: Date.now(),
    }),
  );
});
