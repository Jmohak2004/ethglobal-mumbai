// 0G Router access for the AI routes. Server-only.
// Caller key precedence: the user's own key (x-user-0g-key, billed to their 0G account) then the platform
// ZG_API_KEY. Platform spend requires a wallet session so anonymous traffic cannot burn platform credit.
import { ZG_ROUTER_URL } from "@arena/shared";
import {
  InsufficientBalanceError,
  ModelOutputError,
  ZeroGApiError,
  ZeroGRouter,
} from "@arena/zerog";

import { env } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";
import { requireSession } from "@/lib/server/session";

export interface ZgCaller {
  router: ZeroGRouter;
  payer: "user" | "platform";
}

const USER_KEY = /^sk-[A-Za-z0-9_-]{8,256}$/;

function routerBaseUrl(): string {
  const e = env();
  return e.ZG_ROUTER_URL || (e.NETWORK === "mainnet" ? ZG_ROUTER_URL.mainnet : ZG_ROUTER_URL.testnet);
}

export function zgCaller(req: Request): ZgCaller {
  const userKey = req.headers.get("x-user-0g-key")?.trim();
  if (userKey) {
    if (!USER_KEY.test(userKey)) throw new ApiError(400, "VALIDATION", "x-user-0g-key must be a 0G sk- key");
    return { router: new ZeroGRouter({ apiKey: userKey, payer: "user", baseUrl: routerBaseUrl() }), payer: "user" };
  }
  const platformKey = env().ZG_API_KEY;
  if (!platformKey) {
    throw new ApiError(503, "NOT_DEPLOYED", "No 0G key available. Add your own key in settings, or the platform key is not configured.");
  }
  requireSession(req);
  return { router: new ZeroGRouter({ apiKey: platformKey, payer: "platform", baseUrl: routerBaseUrl() }), payer: "platform" };
}

/** Maps 0G SDK errors to typed API errors. Upstream text is truncated and never includes the key. */
export function zgError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof InsufficientBalanceError) return new ApiError(402, "UNAVAILABLE", "The 0G account has insufficient balance for this request");
  if (err instanceof ZeroGApiError || err instanceof ModelOutputError) {
    return new ApiError(502, "UPSTREAM", `0G: ${(err as Error).message.slice(0, 200)}`);
  }
  return new ApiError(502, "UPSTREAM", "0G request failed");
}
