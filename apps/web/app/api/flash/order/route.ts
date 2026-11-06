import { NextResponse } from "next/server";

import { submitTicket } from "@/lib/server/flash";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";
import type { OrderSignatures } from "@/lib/types";

export const dynamic = "force-dynamic";

const SIG = /^0x[0-9a-fA-F]+$/;

/**
 * POST { quoteId, signatures }. Submits the order for a quote the server issued to this session. Paper
 * mode and missing Flash keys are refused.
 */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as { quoteId?: unknown; signatures?: unknown } | null;
  if (typeof body?.quoteId !== "string" || typeof body.signatures !== "object" || body.signatures === null) {
    throw new ApiError(422, "VALIDATION", "quoteId and signatures are required");
  }
  const s = body.signatures as Record<string, unknown>;
  const sigs: OrderSignatures = { order: "" };
  const fields = ["order", "permit", "bracketOrder", "bracketPermit"] as const;
  for (const f of fields) {
    const v = s[f];
    if (v === undefined) continue;
    if (typeof v !== "string" || !SIG.test(v)) throw new ApiError(422, "VALIDATION", `${f} must be a 0x signature`);
    sigs[f] = v;
  }
  if (!sigs.order) throw new ApiError(422, "VALIDATION", "order signature is required");
  const res = await submitTicket({ quoteId: body.quoteId, funder: session.address, signatures: sigs });
  return NextResponse.json(res, { status: 201 });
});
