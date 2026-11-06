import { NextResponse } from "next/server";

import { configHash } from "@arena/policy";
import type { ExecutionMode } from "@arena/shared";

import { createAgent, getMyAgents } from "@/lib/data";
import { buildAgentConfig } from "@/lib/server/agent-config";
import { isProduction, env } from "@/lib/server/env";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { assertOwnerAccess, requireSession } from "@/lib/server/session";
import { DEMO_OWNER } from "@/lib/templates";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** GET /api/agents?owner=0x…&demo=1. Owner-only: the session must be the owner (demo override outside production). */
export const GET = route(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const owner = sp.get("owner");
  if (!owner || !ADDRESS.test(owner)) throw new ApiError(400, "BAD_REQUEST", "owner must be a 0x address");
  assertOwnerAccess(req, owner, { demo: sp.get("demo") === "1" });
  return NextResponse.json(await getMyAgents(owner));
});

/**
 * POST /api/agents. Requires a wallet session; the session address becomes the owner. Mode is "live" only
 * when the request asks for it AND the server runs EXECUTION_MODE=live. Demo owner outside production only.
 */
export const POST = route(async (req: Request) => {
  const body = await readJson(req);
  const demo = typeof body === "object" && body !== null && (body as { demo?: unknown }).demo === true;
  const owner = demo && !isProduction() ? DEMO_OWNER : requireSession(req).address;

  const e = env();
  const built = buildAgentConfig(body, e);
  const hash = configHash(built.config);
  const mode: ExecutionMode = built.live && e.EXECUTION_MODE === "live" ? "live" : "paper";

  const { id } = await createAgent({
    name: built.name,
    ownerAddress: owner,
    config: built.config,
    configHash: hash,
    mode,
  });
  return NextResponse.json({ id, mode, configHash: hash, liveRequested: built.live }, { status: 201 });
});
