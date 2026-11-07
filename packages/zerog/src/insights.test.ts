import { describe, expect, test } from "bun:test";
import { digestUserMessage } from "./insights.ts";

describe("digestUserMessage", () => {
  test("opens with a plain-language news query when web search is on", () => {
    const msg = digestUserMessage(["WETH", "cbBTC"], [], true);
    expect(msg.startsWith("Latest crypto market news today for Ethereum (ETH) and Bitcoin (BTC)")).toBe(true);
    expect(msg).toContain('"items": []');
  });
  test("is just the items JSON without web search", () => {
    expect(digestUserMessage(["WETH"], [], false)).toBe(JSON.stringify({ items: [] }, null, 2));
  });
  test("names the Base tokens by project", () => {
    const msg = digestUserMessage(["AERO", "VIRTUAL", "DEGEN", "TOSHI", "WELL", "ZORA"], [], true);
    expect(msg).toContain("Aerodrome (AERO) and Virtuals (VIRTUAL) and Degen (DEGEN) and Toshi (TOSHI)");
    expect(msg).toContain("Moonwell (WELL) and Zora (ZORA)");
  });
});
