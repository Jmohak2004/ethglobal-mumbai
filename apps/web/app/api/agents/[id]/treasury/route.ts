import { NextResponse } from "next/server";

import { getAgentTreasury } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const treasury = await getAgentTreasury(id);
  if (!treasury) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json(treasury);
}
