import { describe, expect, it } from "bun:test";
import type { OrderIntent } from "@arena/shared";
import { FlashMappingError, buildOrderRequest, decimalString, intentToQuoteRequest } from "./mapping.ts";
import { FUNDER, USDC, WETH, quoteFixture, orderTypedDataString } from "./test-helpers.ts";
import type { QuoteRequest } from "./types.ts";

const opts = { chain: "base" as const, funderAddress: FUNDER, integratorFeeBps: 10 };

function intent(over: Partial<OrderIntent>): OrderIntent {
  return { side: "buy", asset: "WETH", quoteAsset: "USDC", orderType: "market", notionalUsd: 100, ...over };
}

describe("intentToQuoteRequest: common fields", () => {
  it("maps a market buy to Base addresses with qty in USDC units", () => {
    const req = intentToQuoteRequest(intent({}), opts);
    expect(req).toEqual({
      targetChain: "base",
      contraChain: "base",
      targetAsset: WETH,
      contraAsset: USDC,
      side: "buy",
      qty: "100",
      orderType: "market",
      funderAddress: FUNDER,
      flashIntegratorFeeBps: "10",
    });
    expect(req.recipientAddress).toBeUndefined();
  });

  it("sets flashIntegratorFeeBps as a string and rejects fees above 1000 bps", () => {
    expect(intentToQuoteRequest(intent({}), { ...opts, integratorFeeBps: 0 }).flashIntegratorFeeBps).toBe("0");
    expect(() => intentToQuoteRequest(intent({}), { ...opts, integratorFeeBps: 1001 })).toThrow(FlashMappingError);
  });

  it("sizes a sell in target units using the reference price", () => {
    const req = intentToQuoteRequest(intent({ side: "sell", notionalUsd: 300, orderType: "market" }), {
      ...opts,
      referencePriceUsd: 3000,
    });
    expect(req.side).toBe("sell");
    expect(req.qty).toBe("0.1");
    expect(req.contraAsset).toBe(USDC);
  });

  it("refuses a sell without a reference price", () => {
    expect(() => intentToQuoteRequest(intent({ side: "sell" }), opts)).toThrow(/referencePriceUsd/);
  });

  it("rejects assets that are unknown or USDC itself", () => {
    expect(() => intentToQuoteRequest(intent({ asset: "DOGE" }), opts)).toThrow(/not in the token registry/);
    expect(() => intentToQuoteRequest(intent({ asset: "USDC" }), opts)).toThrow(/cannot be USDC/);
  });

  it("never produces cross-chain fields, whatever the intent says", () => {
    const req = intentToQuoteRequest(intent({}), opts);
    expect(req.targetChain).toBe("base");
    expect(req.contraChain).toBe("base");
    expect(req.recipientAddress).toBeUndefined();
  });
});

describe("intentToQuoteRequest: order types", () => {
  it("limit: limitNotionalPrice from limitPrice", () => {
    const req = intentToQuoteRequest(intent({ orderType: "limit", limitPrice: 2950.5 }), opts);
    expect(req.orderType).toBe("limit");
    expect(req.limitNotionalPrice).toBe("2950.5");
    expect(req.triggers).toBeUndefined();
  });

  it("limit without a price is rejected", () => {
    expect(() => intentToQuoteRequest(intent({ orderType: "limit" }), opts)).toThrow(FlashMappingError);
  });

  it("market with a limit price is rejected (Flash rejects it)", () => {
    expect(() => intentToQuoteRequest(intent({ limitPrice: 3000 }), opts)).toThrow(/not valid for orderType "market"/);
  });

  it("twap: durationSeconds, twapBucketCount, optional limit", () => {
    const req = intentToQuoteRequest(
      intent({ orderType: "twap", twap: { durationSeconds: 600, bucketCount: 10 }, limitPrice: 3100 }),
      opts,
    );
    expect(req.orderType).toBe("twap");
    expect(req.durationSeconds).toBe(600);
    expect(req.twapBucketCount).toBe(10);
    expect(req.limitNotionalPrice).toBe("3100");
  });

  it("twap enforces the Flash minimum duration of 300 s and bucket range 2..2560", () => {
    expect(() =>
      intentToQuoteRequest(intent({ orderType: "twap", twap: { durationSeconds: 299, bucketCount: 10 } }), opts),
    ).toThrow(/>= 300/);
    expect(() =>
      intentToQuoteRequest(intent({ orderType: "twap", twap: { durationSeconds: 600, bucketCount: 1 } }), opts),
    ).toThrow(/between 2 and 2560/);
  });

  it("stop: market buy on an upper trigger", () => {
    const req = intentToQuoteRequest(intent({ orderType: "stop", triggerPrice: 3500 }), opts);
    expect(req.triggers).toEqual([{ notionalPrice: "3500", triggerType: "upper" }]);
  });

  it("stop is buy-only", () => {
    expect(() => intentToQuoteRequest(intent({ side: "sell", orderType: "stop", triggerPrice: 3500 }), { ...opts, referencePriceUsd: 3000 })).toThrow(/requires side buy/);
  });

  it("stop-loss: sell on a lower trigger", () => {
    const req = intentToQuoteRequest(intent({ side: "sell", orderType: "stop-loss", triggerPrice: 2800 }), {
      ...opts,
      referencePriceUsd: 3000,
    });
    expect(req.triggers).toEqual([{ notionalPrice: "2800", triggerType: "lower" }]);
  });

  it("take-profit: sell on an upper trigger", () => {
    const req = intentToQuoteRequest(intent({ side: "sell", orderType: "take-profit", triggerPrice: 4000 }), {
      ...opts,
      referencePriceUsd: 3000,
    });
    expect(req.triggers).toEqual([{ notionalPrice: "4000", triggerType: "upper" }]);
  });

  it("trailing-stop: trailPercent in percent becomes a decimal fraction, triggerPrice becomes activationPrice", () => {
    const req = intentToQuoteRequest(
      intent({ side: "sell", orderType: "trailing-stop", trailPercent: 5, triggerPrice: 3600 }),
      { ...opts, referencePriceUsd: 3000 },
    );
    expect(req.trailingStop).toEqual({ trailPercent: "0.05", activationPrice: "3600" });
    expect(req.triggers).toBeUndefined();
    expect(req.limitNotionalPrice).toBeUndefined();
  });

  it("trailing-stop: trailPercent outside 0.5..50 percent is rejected (API range 0.005..0.5)", () => {
    expect(() =>
      intentToQuoteRequest(intent({ side: "sell", orderType: "trailing-stop", trailPercent: 60 }), { ...opts, referencePriceUsd: 3000 }),
    ).toThrow(/between 0.5 and 50/);
  });

  it("trailing-stop-limit maps the same trail and rejects a limit price (semantics not documented)", () => {
    const req = intentToQuoteRequest(
      intent({ side: "sell", orderType: "trailing-stop-limit", trailPercent: 2.5 }),
      { ...opts, referencePriceUsd: 3000 },
    );
    expect(req.trailingStop?.trailPercent).toBe("0.025");
    expect(() =>
      intentToQuoteRequest(
        intent({ side: "sell", orderType: "trailing-stop-limit", trailPercent: 2.5, limitPrice: 3000 }),
        { ...opts, referencePriceUsd: 3000 },
      ),
    ).toThrow(/limitPrice/);
  });

  it("standalone bracket: sell with two opposite triggers from attachedBracket prices", () => {
    const req = intentToQuoteRequest(
      intent({
        side: "sell",
        orderType: "bracket",
        attachedBracket: { takeProfitPrice: 4000, stopLossPrice: 2800 },
      }),
      { ...opts, referencePriceUsd: 3000 },
    );
    expect(req.triggers).toEqual([
      { notionalPrice: "4000", triggerType: "upper" },
      { notionalPrice: "2800", triggerType: "lower" },
    ]);
    expect(req.attachedBracket).toBeUndefined();
  });

  it("standalone bracket with take-profit below stop-loss is rejected", () => {
    expect(() =>
      intentToQuoteRequest(
        intent({ side: "sell", orderType: "bracket", attachedBracket: { takeProfitPrice: 2000, stopLossPrice: 2800 } }),
        { ...opts, referencePriceUsd: 3000 },
      ),
    ).toThrow(/above stopLossPrice/);
  });
});

describe("intentToQuoteRequest: attached TP/SL on entries", () => {
  it("buy limit with attachedBracket maps to attachedBracket legs (notionalPrice), no triggers", () => {
    const req = intentToQuoteRequest(
      intent({
        orderType: "limit",
        limitPrice: 3000,
        attachedBracket: { takeProfitPrice: 3600, stopLossPrice: 2700 },
      }),
      opts,
    );
    // Verified against the live API: a limit entry with an attached bracket must use limitCrossPrice.
    expect(req.limitCrossPrice).toBe("3000");
    expect(req.limitNotionalPrice).toBeUndefined();
    expect(req.attachedBracket).toEqual({
      takeProfit: { notionalPrice: "3600" },
      stopLoss: { notionalPrice: "2700" },
    });
    expect(req.triggers).toBeUndefined();
  });

  it("buy market with attachedBracket is allowed", () => {
    const req = intentToQuoteRequest(
      intent({ attachedBracket: { takeProfitPrice: 3600, stopLossPrice: 2700 } }),
      opts,
    );
    expect(req.attachedBracket?.takeProfit.notionalPrice).toBe("3600");
  });

  it("attachedBracket on a stop or trailing entry is rejected", () => {
    expect(() =>
      intentToQuoteRequest(
        intent({ orderType: "stop", triggerPrice: 3500, attachedBracket: { takeProfitPrice: 3600, stopLossPrice: 2700 } }),
        opts,
      ),
    ).toThrow(/only valid on market, limit or twap/);
  });

  it("attachedBracket on a sell is rejected (legs protect the received asset, which is USDC)", () => {
    expect(() =>
      intentToQuoteRequest(
        intent({ side: "sell", attachedBracket: { takeProfitPrice: 3600, stopLossPrice: 2700 } }),
        { ...opts, referencePriceUsd: 3000 },
      ),
    ).toThrow(/requires a buy entry/);
  });

  it("inverted attached legs are rejected", () => {
    expect(() =>
      intentToQuoteRequest(intent({ attachedBracket: { takeProfitPrice: 2000, stopLossPrice: 2700 } }), opts),
    ).toThrow(/above stopLossPrice/);
  });
});

describe("decimalString", () => {
  it("never emits exponent notation and strips trailing zeros", () => {
    expect(decimalString(3000, 8)).toBe("3000");
    expect(decimalString(0.0000001, 8)).toBe("0.00000010".replace(/0+$/, ""));
    expect(decimalString(1.5, 6)).toBe("1.5");
  });

  it("drops float noise and truncates instead of rounding, so sells never exceed the intended quantity", () => {
    expect(decimalString(0.1 * 3, 18)).toBe("0.3");
    expect(decimalString(1 / 3, 6)).toBe("0.333333");
    expect(decimalString(2.9999999, 2)).toBe("2.99");
  });
});

describe("buildOrderRequest", () => {
  const baseReq: QuoteRequest = {
    targetChain: "base",
    contraChain: "base",
    targetAsset: WETH,
    contraAsset: USDC,
    side: "buy",
    qty: "100",
    orderType: "twap",
    funderAddress: FUNDER,
    flashIntegratorFeeBps: "10",
    durationSeconds: 600,
    twapBucketCount: 10,
    expireTime: "2026-12-01T00:00:00Z",
    evmUsePermit2: true,
  };

  it("echoes the quote's typed data, quoteId and fee; drops quote-only fields", () => {
    const out = buildOrderRequest(baseReq, quoteFixture(), { userSignature: "0xaa" });
    expect(out.quoteId).toBe("q_abc123");
    expect(out.userSignature).toBe("0xaa");
    expect(out.evmOrderTypedData).toBe(orderTypedDataString);
    expect(out.flashIntegratorFeeBps).toBe("10");
    expect(out.twapBucketCount).toBe(10);
    expect(out).not.toHaveProperty("durationSeconds");
    expect(out).not.toHaveProperty("expireTime");
    expect(out).not.toHaveProperty("evmUsePermit2");
    expect(out.evmPermitTypedData).toBeUndefined();
  });

  it("requires a Permit2 signature when the quote returned permitTypedData, and echoes it", () => {
    const quote = quoteFixture({ evm: { approveTx: null, permitTypedData: "{\"p\":1}", orderTypedData: orderTypedDataString } });
    expect(() => buildOrderRequest(baseReq, quote, { userSignature: "0xaa" })).toThrow(/Permit2/);
    const out = buildOrderRequest(baseReq, quote, { userSignature: "0xaa", evmPermitSignature: "0xbb" });
    expect(out.evmPermitTypedData).toBe("{\"p\":1}");
    expect(out.evmPermitSignature).toBe("0xbb");
  });

  it("builds attachedBracket from quote signing data plus the bracket signature", () => {
    const req: QuoteRequest = {
      ...baseReq,
      orderType: "market",
      durationSeconds: undefined,
      twapBucketCount: undefined,
      attachedBracket: { takeProfit: { notionalPrice: "3600" }, stopLoss: { notionalPrice: "2700" } },
    };
    const quote = quoteFixture({
      attachedBracket: {
        evm: { approveTx: null, permitTypedData: null, orderTypedData: orderTypedDataString },
        svm: null,
        salt: "0x01",
        deadline: "1900000000",
        signedMaxFromAmount: "100000000",
      },
    });
    expect(() => buildOrderRequest(req, quote, { userSignature: "0xaa" })).toThrow(/attachedBracket signatures/);
    const out = buildOrderRequest(req, quote, { userSignature: "0xaa", attachedBracket: { userSignature: "0xcc" } });
    expect(out.attachedBracket).toEqual({
      takeProfit: { notionalPrice: "3600" },
      stopLoss: { notionalPrice: "2700" },
      userSignature: "0xcc",
      salt: "0x01",
      deadline: "1900000000",
      signedMaxFromAmount: "100000000",
    });
  });

  it("refuses a quote without evm typed data", () => {
    expect(() => buildOrderRequest(baseReq, quoteFixture({ evm: null }), { userSignature: "0xaa" })).toThrow(/evm.orderTypedData/);
  });
});

describe("limit entries with an attached bracket", () => {
  it("use limitCrossPrice (Flash v1 rejects limitNotionalPrice with a bracket)", () => {
    const req = intentToQuoteRequest(
      {
        side: "buy",
        asset: "WETH",
        quoteAsset: "USDC",
        orderType: "limit",
        notionalUsd: 1,
        limitPrice: 2000,
        attachedBracket: { takeProfitPrice: 2600, stopLossPrice: 1900 },
      },
      { chain: "base", funderAddress: "0x000000000000000000000000000000000000dEaD", integratorFeeBps: 10 },
    );
    expect(req.limitCrossPrice).toBe("2000");
    expect(req.limitNotionalPrice).toBeUndefined();
  });
});
