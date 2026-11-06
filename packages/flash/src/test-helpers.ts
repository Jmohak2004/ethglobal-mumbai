// Test-only helpers. Not re-exported from index.ts.

import type { Clock } from "./client.ts";
import type { FlashOrder, QuoteResponse } from "./types.ts";

/** Deterministic clock. sleep() advances time instead of waiting. */
export function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  const clock: Clock & { sleeps: number[] } = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
  return clock;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  at: number;
}

export type Responder = (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> };

/**
 * Mock fetch. Each call is handed to `respond`. JSON bodies are serialized; string bodies are sent as-is.
 * Calls are recorded for assertions.
 */
export function mockFetch(respond: Responder, clock?: Clock) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      at: clock ? clock.now() : 0,
    };
    calls.push(call);
    const r = respond(call);
    const status = r.status ?? 200;
    const text = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(text, { status, headers: r.headers });
  };
  return { fetch: fetchImpl, calls };
}

export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const FUNDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
export const ORDER_ID = "6f1f3f0e-2a5b-4c1d-9d8e-111122223333";

/** Canned EIP-712 order payload in the shape Flash returns (JSON string). Field names are illustrative. */
export const orderTypedDataString = JSON.stringify({
  domain: { name: "Flash", version: "1", chainId: "8453", verifyingContract: "0x0000000000000000000000000000000000000001" },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: [
      { name: "maker", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Order",
  message: { maker: FUNDER, amount: "1000000", deadline: "1900000000" },
});

export function quoteFixture(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    quoteId: "q_abc123",
    bridgeQuoteId: null,
    orderType: "market",
    side: "buy",
    targetAsset: WETH,
    contraAsset: USDC,
    from: { asset: "contra", amount: "100", notional: "100" },
    to: { asset: "target", amount: "0.04", notional: "100" },
    fees: { estimatedFeeNotional: "0.1" },
    estimatedPriceImpact: "0.0042",
    recommendedSlippage: "0.01",
    evm: { approveTx: null, permitTypedData: null, orderTypedData: orderTypedDataString },
    ...overrides,
  } as QuoteResponse;
}

export function orderFixture(overrides: Partial<FlashOrder> = {}): FlashOrder {
  const asset = (ticker: string, address: string) => ({
    id: ticker,
    name: ticker,
    address,
    ticker,
    chain: { id: "8453", name: "Base", namespace: "eip155" },
  });
  return {
    orderId: ORDER_ID,
    orderType: "market",
    side: "buy",
    status: "ORDER_STATUS_FILLED",
    closeReason: null,
    funderAddress: FUNDER,
    recipientAddress: null,
    integratorFeeBps: "10",
    tradeFeeBps: "5",
    targetAsset: asset("WETH", WETH),
    contraAsset: asset("USDC", USDC),
    qty: "100",
    filled: null,
    limitNotionalPrice: null,
    limitCrossPrice: null,
    trigger: null,
    brackets: null,
    maxPriceImpact: null,
    twapBucketCount: null,
    placedAt: "2026-11-06T10:00:00Z",
    acceptedAt: null,
    closedAt: null,
    expiresAt: null,
    ...overrides,
  } as FlashOrder;
}
