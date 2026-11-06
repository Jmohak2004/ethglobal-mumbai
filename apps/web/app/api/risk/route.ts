import { NextResponse } from "next/server";

import { getRisk } from "@/lib/data";
import { route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

/** Current RiskOracle level (Chainlink CRE Crash Sentinel). */
export const GET = route(async () => NextResponse.json(await getRisk()));
