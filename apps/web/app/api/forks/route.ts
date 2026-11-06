import { NextResponse } from "next/server";

import { agentIdToBytes32, fromUsd6 } from "@arena/shared";

import { forkAgent, getAgent } from "@/lib/data";
import { verifyForkTx } from "@/lib/server/chain";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const TX = /^0x[0-9a-fA-F]{64}$/;

/**
 * POST { agentId, txHash }. The buyer (session) paid StrategyMarketplace.fork in this tx. The server checks
 * the receipt for the Forked event, then clones the matching config version into a new agent owned by the buyer.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as { agentId?: unknown; txHash?: unknown } | null;
  if (typeof body?.agentId !== "string" || typeof body.txHash !== "string" || !TX.test(body.txHash)) {
    throw new ApiError(422, "VALIDATION", "agentId and a 32-byte txHash are required");
  }
  const source = await getAgent(body.agentId);
  if (!source) throw new ApiError(404, "NOT_FOUND", "Agent not found");
  if (!source.config.fork.forkable) throw new ApiError(422, "VALIDATION", "This agent is not forkable");

  const txHash = body.txHash as `0x${string}`;
  const { configHash, priceUsd6 } = await verifyForkTx({
    txHash,
    agentIdBytes32: agentIdToBytes32(source.id),
    buyer: session.address,
  });
  const priceUsd = fromUsd6(priceUsd6);
  const result = await forkAgent({
    sourceId: source.id,
    buyer: session.address,
    txHash,
    onchainConfigHash: configHash,
    priceUsd,
  });
  return NextResponse.json(
    { newAgentId: result.newAgentId, sourceAgentId: source.id, txHash, created: result.created },
    { status: result.created ? 201 : 200 },
  );
});
