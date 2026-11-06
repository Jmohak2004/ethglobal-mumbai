import { NextResponse } from "next/server";

import { getRisk } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Current RiskOracle level (Chainlink CRE Crash Sentinel). */
export async function GET() {
  return NextResponse.json(await getRisk());
}
