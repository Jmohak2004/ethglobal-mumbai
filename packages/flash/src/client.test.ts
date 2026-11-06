import { describe, expect, it } from "bun:test";
import { FLASH_API_URL } from "@arena/shared";
import { FlashApiError, FlashClient, TokenBucket } from "./client.ts";
import { FUNDER, ORDER_ID, USDC, WETH, fakeClock, mockFetch, orderFixture, quoteFixture } from "./test-helpers.ts";

const KEY = "test-key-not-real";

function orderPage(ids: string[], nextPageToken: string | null) {
  return { orders: ids.map((id) => orderFixture({ orderId: id })), nextPageToken };
}

describe("FlashClient request shape", () => {
  it("POST /quote sends the API key header, JSON body, and parses the response", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: quoteFixture() }));
    const client = new FlashClient({ apiKey: KEY, fetch });

    const res = await client.quote({
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

    expect(res.quoteId).toBe("q_abc123");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${FLASH_API_URL}/quote`);
    expect(call.headers["x-definitive-api-key"]).toBe(KEY);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toMatchObject({ flashIntegratorFeeBps: "10", funderAddress: FUNDER, orderType: "market" });
  });

  it("baseUrl is overridable and trailing slashes are stripped", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: quoteFixture() }));
    const client = new FlashClient({ apiKey: KEY, baseUrl: "https://example.test/v1/", fetch });
    await client.quote({
      targetChain: "base",
      contraChain: "base",
      targetAsset: WETH,
      contraAsset: USDC,
      side: "buy",
      qty: "1",
      orderType: "market",
    });
    expect(calls[0]!.url).toBe("https://example.test/v1/quote");
  });

  it("getOrder encodes the id and passes funderAddress as a query parameter", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { order: orderFixture(), fills: [] } }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    await client.getOrder(ORDER_ID, FUNDER);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v1/orders/${ORDER_ID}`);
    expect(url.searchParams.get("funderAddress")).toBe(FUNDER);
    expect(calls[0]!.method).toBe("GET");
  });

  it("listOrders joins statuses with commas and defaults pageSize to 50", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: orderPage([], null) }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    await client.listOrders({
      funderAddress: FUNDER,
      statuses: ["ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED"],
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("statuses")).toBe("ORDER_STATUS_ACCEPTED,ORDER_STATUS_PARTIALLY_FILLED");
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(url.searchParams.has("pageToken")).toBe(false);
  });

  it("listOrders rejects pageSize outside 1..200 before calling the API", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: orderPage([], null) }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    await expect(client.listOrders({ funderAddress: FUNDER, pageSize: 201 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("cancelOrder and patchOrder hit the documented paths with the documented bodies", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    await client.cancelOrder(ORDER_ID, { cancelMessage: "m", userSignature: "0xsig" });
    await client.patchOrder(ORDER_ID, { updateMessage: "u", userSignature: "0xsig", limitNotionalPrice: "3000" });
    expect(calls[0]!.url).toBe(`${FLASH_API_URL}/orders/${ORDER_ID}/cancel`);
    expect(calls[0]!.body).toEqual({ cancelMessage: "m", userSignature: "0xsig" });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toBe(`${FLASH_API_URL}/orders/${ORDER_ID}`);
  });

  it("batchCancel enforces 1..25 order IDs", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { results: [] } }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    await expect(client.batchCancel({ orderIds: [], cancelMessage: "m", userSignature: "s" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("balances and search use the documented paths and query params", async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.includes("/search") ? { body: { assets: [] } } : { body: { balances: [] } },
    );
    const client = new FlashClient({ apiKey: KEY, fetch });
    await client.balances(FUNDER);
    await client.search("weth", { chain: "base", limit: 5 });
    expect(calls[0]!.url).toBe(`${FLASH_API_URL}/balances/${FUNDER}`);
    const s = new URL(calls[1]!.url);
    expect(s.pathname).toBe("/v1/search");
    expect(s.searchParams.get("query")).toBe("weth");
    expect(s.searchParams.get("chain")).toBe("base");
    expect(s.searchParams.get("limit")).toBe("5");
  });
});

describe("pagination", () => {
  it("listAllOrders follows nextPageToken across pages", async () => {
    const pages: Record<string, unknown> = {
      "": orderPage(["a", "b"], "t1"),
      t1: orderPage(["c"], "t2"),
      t2: orderPage(["d"], null),
    };
    const { fetch, calls } = mockFetch((c) => {
      const token = new URL(c.url).searchParams.get("pageToken") ?? "";
      return { body: pages[token] };
    });
    const client = new FlashClient({ apiKey: KEY, fetch, rateLimitPerSec: 1000 });

    const all = await client.listAllOrders({ funderAddress: FUNDER, pageSize: 2 });

    expect(all.map((o) => o.orderId)).toEqual(["a", "b", "c", "d"]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("pageToken"))).toEqual([null, "t1", "t2"]);
    expect(new URL(calls[1]!.url).searchParams.get("pageSize")).toBe("2");
  });

  it("listAllOrders aborts on a repeated token instead of looping", async () => {
    const { fetch } = mockFetch(() => ({ body: orderPage(["a"], "same") }));
    const client = new FlashClient({ apiKey: KEY, fetch, rateLimitPerSec: 1000 });
    await expect(client.listAllOrders({ funderAddress: FUNDER })).rejects.toMatchObject({ code: "PAGINATION_LOOP" });
  });
});

describe("error mapping", () => {
  it("maps an ErrorResponse body to FlashApiError with status, code, message and body", async () => {
    const body = { error: { code: "INSUFFICIENT_BALANCE", message: "not enough USDC", details: { need: "100" } } };
    const { fetch } = mockFetch(() => ({ status: 422, body }));
    const client = new FlashClient({ apiKey: KEY, fetch });

    const err = await client
      .quote({ targetChain: "base", contraChain: "base", targetAsset: WETH, contraAsset: USDC, side: "buy", qty: "1", orderType: "market" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FlashApiError);
    const e = err as FlashApiError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(e.message).toBe("not enough USDC");
    expect(e.body).toEqual(body);
  });

  it("maps a non-JSON error body to HTTP_<status>", async () => {
    const { fetch } = mockFetch(() => ({ status: 400, body: "bad gateway html" }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    const err = await client.getOrder(ORDER_ID, FUNDER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlashApiError);
    expect((err as FlashApiError).code).toBe("HTTP_400");
  });

  it("treats a 2xx body that does not match the schema as INVALID_RESPONSE", async () => {
    const { fetch } = mockFetch(() => ({ body: { nope: true } }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    const err = await client.balances(FUNDER).catch((e: unknown) => e);
    expect((err as FlashApiError).code).toBe("INVALID_RESPONSE");
  });

  it("never includes the API key in error messages", async () => {
    const { fetch } = mockFetch(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "bad key" } } }));
    const client = new FlashClient({ apiKey: KEY, fetch });
    const err = (await client.balances(FUNDER).catch((e: unknown) => e)) as FlashApiError;
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err.body)).not.toContain(KEY);
  });
});

describe("retries", () => {
  it("retries GET on 503 with backoff and succeeds", async () => {
    const clock = fakeClock();
    let n = 0;
    const { fetch, calls } = mockFetch(
      () => (++n < 3 ? { status: 503, body: { error: { code: "UNAVAILABLE", message: "x" } } } : { body: { balances: [] } }),
      clock,
    );
    const client = new FlashClient({ apiKey: KEY, fetch, clock, random: () => 0, backoffBaseMs: 100 });
    const res = await client.balances(FUNDER);
    expect(res.balances).toEqual([]);
    expect(calls).toHaveLength(3);
    // random()=0 gives the lower bound of equal jitter: 50 ms, then 100 ms.
    expect(clock.sleeps.filter((ms) => ms >= 50)).toEqual([50, 100]);
  });

  it("gives up on GET after maxRetries", async () => {
    const clock = fakeClock();
    const { fetch, calls } = mockFetch(() => ({ status: 500, body: { error: { code: "INTERNAL", message: "x" } } }), clock);
    const client = new FlashClient({ apiKey: KEY, fetch, clock, maxRetries: 2 });
    await expect(client.balances(FUNDER)).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it("waits at least RateLimit-Reset seconds on a GET 429", async () => {
    const clock = fakeClock();
    let n = 0;
    const { fetch } = mockFetch(
      () =>
        ++n === 1
          ? { status: 429, body: { error: { code: "RATE_LIMITED", message: "slow" } }, headers: { "RateLimit-Reset": "1" } }
          : { body: { balances: [] } },
      clock,
    );
    const client = new FlashClient({ apiKey: KEY, fetch, clock, random: () => 0, backoffBaseMs: 10 });
    await client.balances(FUNDER);
    expect(clock.sleeps.some((ms) => ms >= 1000)).toBe(true);
  });

  it("never retries order submission, even on 503", async () => {
    const clock = fakeClock();
    const { fetch, calls } = mockFetch(() => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "x" } } }), clock);
    const client = new FlashClient({ apiKey: KEY, fetch, clock });
    const err = await client
      .submitOrder({
        targetChain: "base",
        contraChain: "base",
        targetAsset: WETH,
        contraAsset: USDC,
        side: "buy",
        qty: "1",
        orderType: "market",
        funderAddress: FUNDER,
        userSignature: "0xsig",
        quoteId: "q_abc123",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlashApiError);
    expect(calls).toHaveLength(1);
  });

  it("never retries cancel or patch on 429", async () => {
    const clock = fakeClock();
    const { fetch, calls } = mockFetch(() => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "x" } } }), clock);
    const client = new FlashClient({ apiKey: KEY, fetch, clock });
    await expect(client.cancelOrder(ORDER_ID, { cancelMessage: "m", userSignature: "s" })).rejects.toBeInstanceOf(FlashApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("TokenBucket spaces requests at the configured rate after the burst", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 5, clock);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      await bucket.acquire();
      times.push(clock.now());
    }
    // Burst of 5 is immediate. Then one token every 200 ms.
    expect(times).toEqual([0, 0, 0, 0, 0, 200, 400]);
  });

  it("queues concurrent acquires in FIFO order", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 1, clock);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map((i) =>
        bucket.acquire().then(() => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2]);
    expect(clock.sleeps).toEqual([200, 200]);
  });

  it("each endpoint has its own bucket, so one endpoint does not throttle another", async () => {
    const clock = fakeClock();
    const { fetch, calls } = mockFetch((c) => (c.url.includes("/search") ? { body: { assets: [] } } : { body: { balances: [] } }), clock);
    const client = new FlashClient({ apiKey: KEY, fetch, clock });
    // Five calls on each endpoint fit inside their own burst, so no sleeps are needed.
    for (let i = 0; i < 5; i++) {
      await client.balances(FUNDER);
      await client.search("weth");
    }
    expect(calls).toHaveLength(10);
    expect(clock.sleeps).toEqual([]);
  });

  it("the sixth call on one endpoint waits for a token", async () => {
    const clock = fakeClock();
    const { fetch } = mockFetch(() => ({ body: { balances: [] } }), clock);
    const client = new FlashClient({ apiKey: KEY, fetch, clock });
    for (let i = 0; i < 6; i++) await client.balances(FUNDER);
    expect(clock.sleeps).toEqual([200]);
  });
});

describe("listAllOrders uses pagination through the limiter", () => {
  it("does not exceed the per-endpoint rate across many pages", async () => {
    const clock = fakeClock();
    let page = 0;
    const { fetch, calls } = mockFetch(
      () => {
        page++;
        return { body: orderPage([`o${page}`], page < 8 ? `t${page}` : null) };
      },
      clock,
    );
    const client = new FlashClient({ apiKey: KEY, fetch, clock });
    const all = await client.listAllOrders({ funderAddress: FUNDER });
    expect(all).toHaveLength(8);
    // Eight calls at 5/s: the calls after the burst are at least 200 ms apart.
    const times = calls.map((c) => c.at);
    for (let i = 6; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200);
    }
  });
});
