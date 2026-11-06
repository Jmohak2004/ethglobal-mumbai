import { describe, expect, test } from "bun:test";
import type { StrategyConfig } from "@arena/shared";
import { InsufficientBalanceError } from "./errors.ts";
import { type DecideInput, decide } from "./decide.ts";
import { ZeroGRouter } from "./router.ts";
import { chatCompletion, jsonResponse, scriptedFetch } from "./test-helpers.ts";

const BASE = "https://router.test/v1";

const config: StrategyConfig = {
  template: "momentum",
  assets: ["WETH", "cbBTC"],
  sliders: { lookback: 20 },
  limits: {
    maxTradeUsd: 1,
    maxOpenPositions: 2,
    maxAllocationUsd: 5,
    maxDailyLossUsd: 1,
    maxDrawdownPct: 10,
    cooldownSec: 600,
  },
  tickIntervalSec: 300,
  modelTier: "balanced",
  crashMode: "tighten_stops",
  commissionBps: 1000,
  autoTune: { enabled: false, maxDeltaPct: 0 },
  publicCommentary: "off",
  insightSources: [],
  fork: { forkable: false, priceUsd: 0 },
};

const input: DecideInput = {
  agentName: "Ada",
  config,
  templateSummary: "Momentum: market and limit entries; TP/SL required.",
  market: [],
  lessons: [],
  risk: "NORMAL",
  budget: "healthy",
  openPositions: [],
};

const VALID_BUY = JSON.stringify({
  forecast: { asset: "WETH", horizonMin: 60, direction: "up", expectedMovePct: 1.2, confidence: 0.6 },
  proposal: {
    action: "buy",
    asset: "WETH",
    orderType: "market",
    sizePct: 0.2,
    takeProfitPct: 3,
    stopLossPct: 1.5,
    rationale: "Momentum confirmed.",
  },
});

/** Answers the Nth call with contents[N] (last one repeats). */
function sequenceFetch(contents: string[]) {
  let i = 0;
  return scriptedFetch(() => {
    const content = contents[Math.min(i, contents.length - 1)] ?? "";
    i++;
    return jsonResponse(chatCompletion(content, { request_id: `req-${i}` }));
  });
}

function makeRouter(fetch: ReturnType<typeof scriptedFetch>["fetch"]) {
  return new ZeroGRouter({ apiKey: "sk-test", payer: "agent", baseUrl: BASE, fetch });
}

describe("decide", () => {
  test("returns the validated output on the first valid reply", async () => {
    const { fetch, calls } = sequenceFetch([VALID_BUY]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(false);
    expect(res.error).toBeNull();
    expect(res.output.proposal.action).toBe("buy");
    expect(res.output.proposal.sizePct).toBe(0.2);
    expect(res.output.forecast?.direction).toBe("up");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.response_format).toEqual({ type: "json_object" });
    expect(res.trace.requestId).toBe("req-1");
    expect(res.traces).toHaveLength(1);
  });

  test("uses the tier model when healthy and the economical model on low budget", async () => {
    const healthy = sequenceFetch([VALID_BUY]);
    await decide(makeRouter(healthy.fetch), input);
    expect(healthy.calls[0]?.body?.model).toBe("qwen3.8-max");

    const low = sequenceFetch([VALID_BUY]);
    await decide(makeRouter(low.fetch), { ...input, budget: "low" });
    expect(low.calls[0]?.body?.model).toBe("0gm-1.0-35b-a3b");
  });

  test("accepts a reply wrapped in a markdown code fence", async () => {
    const { fetch } = sequenceFetch(["```json\n" + VALID_BUY + "\n```"]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(false);
    expect(res.output.proposal.action).toBe("buy");
  });

  test("normalizes null optional fields to undefined and a null forecast", async () => {
    const content = JSON.stringify({
      forecast: null,
      proposal: { action: "hold", asset: null, sizePct: null, rationale: "No edge." },
    });
    const { fetch } = sequenceFetch([content]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(false);
    expect(res.output.forecast).toBeNull();
    expect(res.output.proposal.asset).toBeUndefined();
    expect(res.output.proposal.sizePct).toBeUndefined();
  });

  test("retries once after invalid JSON, appending the error to the conversation", async () => {
    const { fetch, calls } = sequenceFetch(["this is not json", VALID_BUY]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(false);
    expect(res.output.proposal.action).toBe("buy");
    expect(calls).toHaveLength(2);
    expect(res.traces.map((t) => t.requestId)).toEqual(["req-1", "req-2"]);

    const messages = calls[1]?.body?.messages as Array<{ role: string; content: string }>;
    const assistant = messages.find((m) => m.role === "assistant");
    const correction = messages.at(-1);
    expect(assistant?.content).toBe("this is not json");
    expect(correction?.role).toBe("user");
    expect(correction?.content).toContain("not valid JSON");
  });

  test("retries once after a schema violation and reports the failing field", async () => {
    const badSize = JSON.stringify({
      forecast: null,
      proposal: { action: "buy", asset: "WETH", sizePct: 1.5, takeProfitPct: 3, stopLossPct: 1, rationale: "x" },
    });
    const { fetch, calls } = sequenceFetch([badSize, VALID_BUY]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(false);
    expect(calls).toHaveLength(2);
    const messages = calls[1]?.body?.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toContain("sizePct");
  });

  test("falls back to a hold proposal when both attempts are invalid", async () => {
    const { fetch, calls } = sequenceFetch(["nope", "still nope"]);

    const res = await decide(makeRouter(fetch), input);

    expect(calls).toHaveLength(2);
    expect(res.fallback).toBe(true);
    expect(res.output.forecast).toBeNull();
    expect(res.output.proposal.action).toBe("hold");
    expect(res.output.proposal.rationale).toContain("rejected after retry");
    expect(res.error).toContain("not valid JSON");
    expect(res.traces).toHaveLength(2);
    expect(res.trace.requestId).toBe("req-2");
  });

  test("hold fallback also covers an out-of-range order type", async () => {
    const bad = JSON.stringify({
      forecast: null,
      proposal: { action: "buy", orderType: "iceberg", rationale: "x" },
    });
    const { fetch } = sequenceFetch([bad, bad]);

    const res = await decide(makeRouter(fetch), input);

    expect(res.fallback).toBe(true);
    expect(res.output.proposal.action).toBe("hold");
    expect(res.error).toContain("orderType");
  });

  test("lets 402 propagate so the runtime can switch to the critical tier", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ error: { message: "Insufficient balance" } }, 402));

    await expect(decide(makeRouter(fetch), input)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});
