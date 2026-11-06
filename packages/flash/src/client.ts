// Typed REST client for the Definitive Flash API.
// - Auth: `x-definitive-api-key` header on every request. The key is supplied by the caller and never logged.
// - Rate limit: 5 req/s per endpoint per key (per the Flash docs). One token bucket per endpoint, requests queue.
// - Retries: only GET requests, only on 429 and 5xx, with exponential backoff (429 uses RateLimit-Reset).
//   Writes (quote, order, cancel, patch, setup-transaction) are never retried automatically.

import { FLASH_API_URL } from "@arena/shared";
import { z } from "zod";
import {
  BatchCancelOrderRequestSchema,
  BatchCancelOrderResponseSchema,
  CancelOrderRequestSchema,
  CancelOrderResponseSchema,
  ErrorResponseSchema,
  FlashBalancesResponseSchema,
  FlashGetOrderResponseSchema,
  FlashListOrdersResponseSchema,
  FlashSearchAssetsResponseSchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  SubmitOrderRequestSchema,
  SubmitOrderResponseSchema,
  SubmitSetupTransactionResponseSchema,
  UpdateOrderRequestSchema,
  UpdateOrderResponseSchema,
  type BatchCancelOrderRequest,
  type BatchCancelOrderResponse,
  type CancelOrderRequest,
  type Chain,
  type FlashBalancesResponse,
  type FlashGetOrderResponse,
  type FlashOrder,
  type FlashOrderStatus,
  type FlashSearchAssetsResponse,
  type QuoteRequest,
  type QuoteResponse,
  type SubmitOrderRequest,
  type SubmitOrderResponse,
  type UpdateOrderRequest,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Any non-2xx response, or a 2xx body that does not match the documented schema (code "INVALID_RESPONSE"). */
export class FlashApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "FlashApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Clock and rate limiting
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Token bucket. `capacity` tokens max, refilled at `ratePerSec`. `acquire()` resolves when a token is
 * available. Callers queue in FIFO order, so requests are spaced at >= 1/ratePerSec once the burst is used.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (ratePerSec <= 0) throw new RangeError("ratePerSec must be > 0");
    if (capacity < 1) throw new RangeError("capacity must be >= 1");
    this.tokens = capacity;
    this.last = clock.now();
  }

  acquire(): Promise<void> {
    const run = async (): Promise<void> => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
        await this.clock.sleep(waitMs);
      }
    };
    const next = this.queue.then(run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSec = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.last = now;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FlashClientOptions {
  apiKey: string;
  /** Defaults to FLASH_API_URL from @arena/shared (https://flash.definitive.fi/v1). */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Requests per second per endpoint. Default 5 (Flash limit). */
  rateLimitPerSec?: number;
  /** Burst size per endpoint. Default equals rateLimitPerSec. */
  rateLimitBurst?: number;
  /** Max retries for GET requests on 429/5xx. Default 3. Writes are never retried. */
  maxRetries?: number;
  /** Base for exponential backoff on GET retries. Default 250 ms. */
  backoffBaseMs?: number;
  clock?: Clock;
  /** Random source in [0, 1) for backoff jitter. Injectable for tests. */
  random?: () => number;
}

export interface ListOrdersParams {
  funderAddress: string;
  statuses?: FlashOrderStatus[];
  /** 1 to 200. Default 50. */
  pageSize?: number;
  pageToken?: string;
}

type Method = "GET" | "POST" | "PATCH";

interface RequestSpec<T extends z.ZodType> {
  /** Rate-limit bucket key, using the spec path template, e.g. "GET /orders/{orderId}". */
  endpoint: string;
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema: T;
}

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;

export class FlashClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly rateLimitPerSec: number;
  private readonly rateLimitBurst: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(opts: FlashClientOptions) {
    if (!opts.apiKey) throw new Error("FlashClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? FLASH_API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.rateLimitPerSec = opts.rateLimitPerSec ?? 5;
    this.rateLimitBurst = opts.rateLimitBurst ?? this.rateLimitPerSec;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
  }

  // ---- Quotes and orders --------------------------------------------------

  /** POST /quote. Not retried. */
  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request({
      endpoint: "POST /quote",
      method: "POST",
      path: "/quote",
      body: QuoteRequestSchema.parse(req),
      schema: QuoteResponseSchema,
    });
  }

  /** POST /order. Never auto-retried, even on 429/5xx: a retry could double-submit. */
  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    return this.request({
      endpoint: "POST /order",
      method: "POST",
      path: "/order",
      body: SubmitOrderRequestSchema.parse(req),
      schema: SubmitOrderResponseSchema,
    });
  }

  /** POST /setup-transaction. Submits a signed approval/wrap tx returned in quote.setupTxs. Not retried. */
  async submitSetupTransaction(signedSetupTx: string): Promise<{ status: "confirmed" | "pending" }> {
    return this.request({
      endpoint: "POST /setup-transaction",
      method: "POST",
      path: "/setup-transaction",
      body: { signedSetupTx },
      schema: SubmitSetupTransactionResponseSchema,
    });
  }

  // ---- Reads --------------------------------------------------------------

  /** GET /orders/{orderId}?funderAddress=. */
  async getOrder(orderId: string, funderAddress: string): Promise<FlashGetOrderResponse> {
    return this.request({
      endpoint: "GET /orders/{orderId}",
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}`,
      query: { funderAddress },
      schema: FlashGetOrderResponseSchema,
    });
  }

  /** GET /orders. One page. */
  async listOrders(params: ListOrdersParams): Promise<z.output<typeof FlashListOrdersResponseSchema>> {
    const pageSize = params.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new RangeError("pageSize must be an integer between 1 and 200");
    }
    return this.request({
      endpoint: "GET /orders",
      method: "GET",
      path: "/orders",
      query: {
        funderAddress: params.funderAddress,
        statuses: params.statuses?.length ? params.statuses.join(",") : undefined,
        pageSize,
        pageToken: params.pageToken,
      },
      schema: FlashListOrdersResponseSchema,
    });
  }

  /** Follows nextPageToken until exhausted. Stops on a repeated token or after maxPages. */
  async listAllOrders(
    params: Omit<ListOrdersParams, "pageToken">,
    opts: { maxPages?: number } = {},
  ): Promise<FlashOrder[]> {
    const maxPages = opts.maxPages ?? 1000;
    const orders: FlashOrder[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.listOrders({ ...params, pageToken });
      orders.push(...res.orders);
      const next = res.nextPageToken;
      if (!next) return orders;
      if (seen.has(next)) {
        throw new FlashApiError(200, "PAGINATION_LOOP", "nextPageToken repeated; aborting pagination", null);
      }
      seen.add(next);
      pageToken = next;
    }
    throw new FlashApiError(200, "PAGINATION_LIMIT", `listAllOrders exceeded ${maxPages} pages`, null);
  }

  /** GET /balances/{address}. */
  async balances(address: string): Promise<FlashBalancesResponse> {
    return this.request({
      endpoint: "GET /balances/{address}",
      method: "GET",
      path: `/balances/${encodeURIComponent(address)}`,
      schema: FlashBalancesResponseSchema,
    });
  }

  /** GET /search?query=&chain=&limit=. */
  async search(
    query: string,
    opts: { chain?: Chain; limit?: number } = {},
  ): Promise<FlashSearchAssetsResponse> {
    if (!query) throw new RangeError("search query must be non-empty");
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 25)) {
      throw new RangeError("search limit must be an integer between 1 and 25");
    }
    return this.request({
      endpoint: "GET /search",
      method: "GET",
      path: "/search",
      query: { query, chain: opts.chain, limit: opts.limit },
      schema: FlashSearchAssetsResponseSchema,
    });
  }

  // ---- Modify and cancel (signed messages come from the caller) ----------

  /** POST /orders/{orderId}/cancel. `cancelMessage` and `userSignature` are produced by the caller. */
  async cancelOrder(orderId: string, body: CancelOrderRequest): Promise<{ ok: true }> {
    return this.request({
      endpoint: "POST /orders/{orderId}/cancel",
      method: "POST",
      path: `/orders/${encodeURIComponent(orderId)}/cancel`,
      body: CancelOrderRequestSchema.parse(body),
      schema: CancelOrderResponseSchema,
    });
  }

  /** POST /orders/cancel. 1 to 25 order IDs. */
  async batchCancel(body: BatchCancelOrderRequest): Promise<BatchCancelOrderResponse> {
    return this.request({
      endpoint: "POST /orders/cancel",
      method: "POST",
      path: "/orders/cancel",
      body: BatchCancelOrderRequestSchema.parse(body),
      schema: BatchCancelOrderResponseSchema,
    });
  }

  /** PATCH /orders/{orderId}. `updateMessage` and `userSignature` are produced by the caller. */
  async patchOrder(orderId: string, body: UpdateOrderRequest): Promise<{ ok: true }> {
    return this.request({
      endpoint: "PATCH /orders/{orderId}",
      method: "PATCH",
      path: `/orders/${encodeURIComponent(orderId)}`,
      body: UpdateOrderRequestSchema.parse(body),
      schema: UpdateOrderResponseSchema,
    });
  }

  // ---- Transport ----------------------------------------------------------

  private bucket(endpoint: string): TokenBucket {
    let b = this.buckets.get(endpoint);
    if (!b) {
      b = new TokenBucket(this.rateLimitPerSec, this.rateLimitBurst, this.clock);
      this.buckets.set(endpoint, b);
    }
    return b;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async request<T extends z.ZodType>(spec: RequestSpec<T>): Promise<z.output<T>> {
    const retriable = spec.method === "GET";
    const attempts = retriable ? this.maxRetries + 1 : 1;
    const url = this.buildUrl(spec.path, spec.query);

    for (let attempt = 0; ; attempt++) {
      await this.bucket(spec.endpoint).acquire();

      const headers: Record<string, string> = {
        "x-definitive-api-key": this.apiKey,
        accept: "application/json",
      };
      const init: RequestInit = { method: spec.method, headers };
      if (spec.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(spec.body);
      }

      const res = await this.fetchImpl(url, init);
      const text = await res.text();
      const parsed = parseJsonSafe(text);

      if (res.ok) {
        const result = spec.schema.safeParse(parsed);
        if (!result.success) {
          throw new FlashApiError(res.status, "INVALID_RESPONSE", `Unexpected response shape for ${spec.endpoint}`, parsed);
        }
        return result.data;
      }

      const err = toApiError(res.status, parsed, text);
      if (retriable && RETRYABLE_STATUS(res.status) && attempt + 1 < attempts) {
        await this.clock.sleep(this.retryDelayMs(attempt, res));
        continue;
      }
      throw err;
    }
  }

  /** Equal-jitter exponential backoff. A 429 waits at least RateLimit-Reset seconds (docs: window is 1 s). */
  private retryDelayMs(attempt: number, res: Response): number {
    const exp = this.backoffBaseMs * 2 ** attempt;
    const jittered = exp / 2 + this.random() * (exp / 2);
    if (res.status === 429) {
      const reset = Number(res.headers.get("RateLimit-Reset"));
      if (Number.isFinite(reset) && reset > 0) return Math.max(jittered, reset * 1000);
    }
    return jittered;
  }
}

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(status: number, parsed: unknown, text: string): FlashApiError {
  const env = ErrorResponseSchema.safeParse(parsed);
  if (env.success) {
    const { code, message } = env.data.error;
    return new FlashApiError(status, code, message, parsed);
  }
  return new FlashApiError(status, `HTTP_${status}`, text ? text.slice(0, 200) : `HTTP ${status}`, parsed);
}

