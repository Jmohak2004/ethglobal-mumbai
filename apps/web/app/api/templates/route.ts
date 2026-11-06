import { NextResponse } from "next/server";

import { getTemplates } from "@/lib/data";
import { route } from "@/lib/server/errors";

export const dynamic = "force-dynamic";

export const GET = route(async () => NextResponse.json(await getTemplates()));
