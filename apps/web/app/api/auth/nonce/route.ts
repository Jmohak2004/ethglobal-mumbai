import { NextResponse } from "next/server";

import { route } from "@/lib/server/errors";
import { issueNonce } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** One-time nonce for the wallet sign-in message (valid 5 minutes). */
export const GET = route(async () => NextResponse.json(issueNonce()));
