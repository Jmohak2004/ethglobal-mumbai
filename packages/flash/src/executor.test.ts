import { describe, expect, it } from "bun:test";
import type { OrderIntent } from "@arena/shared";
import { generatePrivateKey } from "viem/accounts";
import { FlashApiError } from "./client.ts";
import { FlashApprovalRequiredError, FlashExecutor } from "./executor.ts";
import { localSigner, type OrderSigner } from "./signing.ts";
import { USDC, WETH, orderTypedDataString, quoteFixture } from "./test-helpers.ts";
import type { QuoteRequest, QuoteResponse, SubmitOrderRequest } from "./types.ts";

const buyMarket: OrderIntent = { side: "buy", asset: "WETH", quoteAsset: "USDC", orderType: "market", notionalUsd: 100 };

function fakeClient(quote: QuoteResponse = quoteFixture()) {
  const quoteCalls: QuoteRequest[] = [];
  const submitCalls: SubmitOrderRequest[] = [];
  return {
    quoteCalls,
    submitCalls,
    client: {
      quote: async (req: QuoteRequest) => {
        quoteCalls.push(req);
        return quote;
      },
      submitOrder: async (req: SubmitOrderRequest) => {
        submitCalls.push(req);
        return { orderId: "ord_xyz789" };
      },
    },
  };
}

describe("FlashExecutor paper mode", () => {
  it("quotes only: no signing, no submit, simulated fill at the quoted price", async () => {
    const { client, quoteCalls, submitCalls } = fakeClient();
    const signer = localSigner(generatePrivateKey());
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });

    const res = await ex.execute(buyMarket, signer, "paper");

    expect(submitCalls).toHaveLength(0);
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]!.funderAddress).toBe(signer.address);
    expect(quoteCalls[0]!.flashIntegratorFeeBps).toBe("10");
    expect(res.paper).toBe(true);
    if (!res.paper) throw new Error("unreachable");
    expect(res.status).toBe("simulated_fill");
    expect(res.orderId.startsWith("paper-")).toBe(true);
    // Target leg is `to` for a buy: 100 USD for 0.04 WETH gives 2500 USD per WETH.
    expect(res.fill.qty).toBeCloseTo(0.04, 10);
    expect(res.fill.price).toBeCloseTo(2500, 6);
    expect(res.fill.notionalUsd).toBe(100);
  });

  it("paper sell uses the target leg (from) for the price", async () => {
    const quote = quoteFixture({
      side: "sell",
      from: { asset: "target", amount: "0.5", notional: "1500" },
      to: { asset: "contra", amount: "1490", notional: "1490" },
    });
    const { client } = fakeClient(quote);
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });
    const res = await ex.execute(
      { ...buyMarket, side: "sell", notionalUsd: 1500 },
      localSigner(generatePrivateKey()),
      "paper",
      { referencePriceUsd: 3000 },
    );
    if (!res.paper) throw new Error("unreachable");
    expect(res.fill.price).toBe(3000);
    expect(res.fill.qty).toBe(0.5);
  });
});

describe("FlashExecutor live mode", () => {
  it("quote, sign the order typed data, submit once, return the order ID", async () => {
    const { client, quoteCalls, submitCalls } = fakeClient();
    const signer = localSigner(generatePrivateKey());
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });

    const res = await ex.execute(buyMarket, signer, "live");

    expect(quoteCalls).toHaveLength(1);
    expect(submitCalls).toHaveLength(1);
    const sub = submitCalls[0]!;
    expect(sub.quoteId).toBe("q_abc123");
    expect(sub.funderAddress).toBe(signer.address);
    expect(sub.flashIntegratorFeeBps).toBe("10");
    expect(sub.userSignature).toMatch(/^0x[0-9a-f]+$/i);
    expect(sub.evmOrderTypedData).toBe(orderTypedDataString);
    expect(sub.targetAsset).toBe(WETH);
    expect(sub.contraAsset).toBe(USDC);

    expect(res).toMatchObject({ paper: false, orderId: "ord_xyz789", status: "submitted", attachedBracketStatus: null });
  });

  it("signs the attached bracket payload when the intent has TP/SL", async () => {
    const quote = quoteFixture({
      attachedBracket: {
        evm: { approveTx: null, permitTypedData: null, orderTypedData: quoteFixture().evm!.orderTypedData! },
        svm: null,
        salt: "0x01",
        deadline: "1900000000",
        signedMaxFromAmount: "100000000",
      },
    });
    const { client, submitCalls } = fakeClient(quote);
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });
    const intent: OrderIntent = {
      ...buyMarket,
      attachedBracket: { takeProfitPrice: 3600, stopLossPrice: 2700 },
    };
    await ex.execute(intent, localSigner(generatePrivateKey()), "live");
    const ab = submitCalls[0]!.attachedBracket;
    expect(ab?.userSignature).toMatch(/^0x/);
    expect(ab?.salt).toBe("0x01");
    expect(ab?.takeProfit).toEqual({ notionalPrice: "3600" });
  });

  it("throws FlashApprovalRequiredError and does not submit when onchain setup is needed", async () => {
    const quote = quoteFixture({
      evm: { approveTx: { to: USDC, data: "0x095ea7b3" }, permitTypedData: null, orderTypedData: quoteFixture().evm!.orderTypedData! },
    });
    const { client, submitCalls } = fakeClient(quote);
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });

    const err = await ex.execute(buyMarket, localSigner(generatePrivateKey()), "live").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FlashApprovalRequiredError);
    expect((err as FlashApprovalRequiredError).requirements.approveTx?.to).toBe(USDC);
    expect(submitCalls).toHaveLength(0);
  });

  it("propagates FlashApiError from submit without retrying (single submit call)", async () => {
    const quote = quoteFixture();
    let submits = 0;
    const client = {
      quote: async () => quote,
      submitOrder: async (): Promise<never> => {
        submits++;
        throw new FlashApiError(503, "UNAVAILABLE", "try later", null);
      },
    };
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });
    await expect(ex.execute(buyMarket, localSigner(generatePrivateKey()), "live")).rejects.toBeInstanceOf(FlashApiError);
    expect(submits).toBe(1);
  });

  it("works with any OrderSigner implementation (e.g. a remote wallet) and passes normalized typed data", async () => {
    const { client, submitCalls } = fakeClient();
    const seen: { primaryType: string; amount: unknown }[] = [];
    const remote: OrderSigner = {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      signTypedData: async (td) => {
        seen.push({ primaryType: td.primaryType, amount: td.message.amount });
        return "0xabcdef";
      },
    };
    const ex = new FlashExecutor({ client, integratorFeeBps: 10 });
    await ex.execute(buyMarket, remote, "live");
    expect(seen).toEqual([{ primaryType: "Order", amount: 1000000n }]);
    expect(submitCalls[0]!.userSignature).toBe("0xabcdef");
  });
});
