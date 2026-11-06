import { NextResponse } from "next/server";

import { createAgent, getMyAgents } from "@/lib/data";
import { validateCreateInput } from "@/lib/templates";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** GET /api/agents?owner=0x… returns agents owned by the wallet. */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner");
  if (!owner || !ADDRESS.test(owner)) {
    return NextResponse.json({ error: "owner must be a 0x address" }, { status: 400 });
  }
  return NextResponse.json(await getMyAgents(owner));
}

/** POST /api/agents { name, ownerAddress, config } validates against platform caps and returns { id }. */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  const result = validateCreateInput(body);
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: 400 });
  const { id } = await createAgent(result.value);
  return NextResponse.json({ id }, { status: 201 });
}
