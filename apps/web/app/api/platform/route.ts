import { NextResponse } from "next/server";

import { dbConfigured } from "@/lib/server/db";
import { demoControlsEnabled, env, flashLive, sessionSecret } from "@/lib/server/env";
import { route } from "@/lib/server/errors";
import type { PlatformInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Public platform settings for the UI (no secrets). */
export const GET = route(async () => {
  const e = env();
  const info: PlatformInfo = {
    executionMode: e.EXECUTION_MODE,
    allowedTokens: e.ALLOWED_TOKENS,
    network: e.NETWORK,
    flashLive: flashLive(),
    platformZgKey: Boolean(e.ZG_API_KEY),
    demoControls: demoControlsEnabled(),
    dbEnabled: dbConfigured(),
    sessionEnabled: Boolean(sessionSecret()),
    caps: {
      maxTradeUsd: e.MAX_TRADE_USD,
      maxAgentAllocationUsd: e.MAX_AGENT_ALLOCATION_USD,
      maxDailyLossUsd: e.MAX_DAILY_LOSS_USD_PER_AGENT,
      maxOpenPositions: e.MAX_OPEN_POSITIONS,
      flashIntegratorFeeBps: e.FLASH_INTEGRATOR_FEE_BPS,
    },
  };
  return NextResponse.json(info);
});
