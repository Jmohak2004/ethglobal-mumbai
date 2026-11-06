import { NextResponse } from "next/server";

import { ApiError, readJson, route } from "@/lib/server/errors";
import { requestHost, setSessionCookie, verifySignIn } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** POST { address, message, signature }. Sets the httpOnly session cookie on success. */
export const POST = route(async (req: Request) => {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null) throw new ApiError(400, "BAD_REQUEST", "Body must be a JSON object");
  const { address, message, signature } = body as Record<string, unknown>;
  if (typeof address !== "string" || typeof message !== "string" || typeof signature !== "string") {
    throw new ApiError(422, "VALIDATION", "address, message and signature are required strings");
  }
  await verifySignIn({ address, message, signature }, requestHost(req));
  const expiresAt = await setSessionCookie(address);
  return NextResponse.json({ address: address.toLowerCase(), expiresAt });
});
