import { describe, expect, test } from "bun:test";
import { BASE_TOKENS, COINBASE_PRODUCTS } from "./chains.ts";

const NEW_TOKENS: Record<string, { address: string; product: string }> = {
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", product: "AERO-USD" },
  VIRTUAL: { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", product: "VIRTUAL-USD" },
  DEGEN: { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", product: "DEGEN-USD" },
  TOSHI: { address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", product: "TOSHI-USD" },
  WELL: { address: "0xA88594D404727625A9437C3f886C7643872296AE", product: "WELL-USD" },
  ZORA: { address: "0x1111111111166b7FE7bd91427724B487980aFc69", product: "ZORA-USD" },
};

describe("Base mainnet token registry", () => {
  test("the six new tokens have their mainnet address, 18 decimals and no Chainlink feed", () => {
    for (const [symbol, { address }] of Object.entries(NEW_TOKENS)) {
      const token = BASE_TOKENS[symbol];
      expect(token).toBeDefined();
      expect(token?.symbol).toBe(symbol);
      expect(token?.address).toBe(address as `0x${string}`);
      expect(token?.decimals).toBe(18);
      expect(token?.usdFeed).toBeNull();
    }
  });

  test("each new token maps to its Coinbase product", () => {
    for (const [symbol, { product }] of Object.entries(NEW_TOKENS)) {
      expect(COINBASE_PRODUCTS[symbol]).toBe(product);
    }
  });

  test("WETH and cbBTC keep their Coinbase products", () => {
    expect(COINBASE_PRODUCTS.WETH).toBe("ETH-USD");
    expect(COINBASE_PRODUCTS.cbBTC).toBe("BTC-USD");
  });

  test("every Coinbase-mapped ticker is in BASE_TOKENS, and nothing else is", () => {
    expect(Object.keys(COINBASE_PRODUCTS).sort()).toEqual(
      Object.keys(BASE_TOKENS).filter((s) => s !== "USDC").sort(),
    );
  });

  test("Coinbase products follow the <SYMBOL>-USD form", () => {
    for (const product of Object.values(COINBASE_PRODUCTS)) expect(product).toMatch(/^[A-Z]+-USD$/);
  });
});
