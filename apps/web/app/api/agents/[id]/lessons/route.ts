import { NextResponse } from "next/server";

import { getAgentLessons } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lessons = await getAgentLessons(id);
  if (lessons.length === 0) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json(lessons);
}
