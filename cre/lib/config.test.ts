// Keeps the feed addresses in the per-workflow configs in sync with lib/chains.ts.
import { describe, expect, test } from "bun:test";
import { DATA_FEEDS } from "./chains.ts";

const load = async (p: string) => (await import(p, { with: { type: "json" } })).default as Record<string, any>;

describe("config feeds match lib/chains.ts", () => {
  test("WF1 staging uses Base Sepolia feeds", async () => {
    const c = await load("../wf1-performance-attestor/config.staging.json");
    expect(c.feeds).toEqual({ ETH_USD: DATA_FEEDS.baseSepolia.ETH_USD, BTC_USD: DATA_FEEDS.baseSepolia.BTC_USD });
  });
  test("WF1 production uses Base mainnet feeds", async () => {
    const c = await load("../wf1-performance-attestor/config.production.json");
    expect(c.feeds).toEqual({ ETH_USD: DATA_FEEDS.base.ETH_USD, BTC_USD: DATA_FEEDS.base.BTC_USD });
    expect(c.isTestnet).toBe(false);
  });
  test("WF2 production never accepts simulate payloads", async () => {
    const c = await load("../wf2-crash-sentinel/config.production.json");
    expect(c.allowSimulate).toBe(false);
    expect(c.feeds).toEqual({ ETH_USD: DATA_FEEDS.base.ETH_USD, BTC_USD: DATA_FEEDS.base.BTC_USD });
  });
});
