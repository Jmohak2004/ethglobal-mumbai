import { NextResponse } from "next/server";

import { parseCancelIds, submitCancel } from "@/lib/server/flash";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * POST { orderIds, message, signature }. The funder is the signed-in session. Sends the cancel to Flash only when
 * the message is the one issued for these ids and the signature recovers to the session address.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") throw new ApiError(422, "VALIDATION", "orderIds, message and signature are required");
  const orderIds = parseCancelIds(body.orderIds, true);
  if (typeof body.message !== "string" || body.message.length === 0 || body.message.length > 2000) {
    throw new ApiError(422, "VALIDATION", "message is required");
  }
  if (typeof body.signature !== "string" || !EVM_SIGNATURE.test(body.signature)) {
    throw new ApiError(422, "VALIDATION", "signature must be a 65-byte 0x signature");
  }
  const results = await submitCancel({
    orderIds,
    message: body.message,
    signature: body.signature as `0x${string}`,
    funder: session.address,
  });
  return NextResponse.json({ results });
});
