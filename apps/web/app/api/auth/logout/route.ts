import { NextResponse } from "next/server";

import { route } from "@/lib/server/errors";
import { clearSessionCookie } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
});
