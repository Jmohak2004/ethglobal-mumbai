import { NextResponse } from "next/server";

import { getAgent } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}
