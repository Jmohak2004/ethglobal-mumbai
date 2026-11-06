import { NextResponse } from "next/server";

import { getAgentEpisodes } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Owner-only in the UI. The API must enforce owner auth before real data lands (signed message). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const episodes = await getAgentEpisodes(id);
  if (episodes.length === 0) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json(episodes);
}
