import { NextResponse } from "next/server";

import { getHumansPrefs, setHumansBoardOptIn } from "@/lib/data";
import { ApiError, readJson, route } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** The signed-in wallet's preferences (Humans board opt-in). */
export const GET = route(async (req: Request) => {
  const session = requireSession(req);
  return NextResponse.json(await getHumansPrefs(session.address));
});

/** POST { humansBoardOptIn: boolean }. Opting in ranks the wallet's manual trades on the Humans board. */
export const POST = route(async (req: Request) => {
  const session = requireSession(req);
  const body = (await readJson(req)) as { humansBoardOptIn?: unknown } | null;
  if (typeof body?.humansBoardOptIn !== "boolean") {
    throw new ApiError(422, "VALIDATION", "humansBoardOptIn must be true or false");
  }
  return NextResponse.json(await setHumansBoardOptIn(session.address, body.humansBoardOptIn));
});
