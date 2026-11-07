// Definitive Flash bridge: ticket -> OrderIntent -> quote -> signing payloads -> order. Server-only.
// Paper mode never calls Flash for writes and never returns signing payloads.
import {
  FlashApiError,
  FlashClient,
  FlashMappingError,
  ORDER_ID_PATTERN,
  approvalRequirements,
  buildBatchCancelMessage,
  buildCancelMessage,
  buildOrderRequest,
  intentToQuoteRequest,
  type FlashFill,
  type FlashOrder,
  type QuoteRequest,
  type QuoteResponse,
} from "@arena/flash";
import { BASE_TOKENS, FLASH_API_URL, type OrderIntent } from "@arena/shared";
import { verifyMessage } from "viem";

import { env, flashLive } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";
import type {
  Balance,
  CancelPlan,
  CancelResult,
  Fill,
  OnchainStep,
  OpenOrder,
  OrderSignatures,
  TicketInput,
  TradeQuote,
  TradingActivity,
  TypedDataJson,
} from "@/lib/types";

const QUOTE_TTL_MS = 2 * 60_000;

let client: FlashClient | undefined;
function flash(): FlashClient {
  const key = env().DEFINITIVE_API_KEY;
  if (!key) throw new ApiError(503, "UNAVAILABLE", "Flash is not configured (DEFINITIVE_API_KEY)");
  client ??= new FlashClient({ apiKey: key, baseUrl: FLASH_API_URL });
  return client;
}

// ---- Quote store: the server keeps the request it quoted, so the client cannot change funder or fields. ----

interface StoredQuote {
  funder: string;
  req: QuoteRequest;
  quote: QuoteResponse;
  notionalUsd: number;
  createdAt: number;
}
const QUOTES_KEY = "__arenaFlashQuotes";
function quotes(): Map<string, StoredQuote> {
  const g = globalThis as Record<string, unknown>;
  if (!g[QUOTES_KEY]) g[QUOTES_KEY] = new Map<string, StoredQuote>();
  return g[QUOTES_KEY] as Map<string, StoredQuote>;
}

/** Paper quotes the server issued, so a paper fill can only be recorded at the price Flash actually quoted. */
export interface StoredPaperQuote {
  funder: string;
  side: "buy" | "sell";
  asset: string;
  orderType: TicketInput["orderType"];
  notionalUsd: number;
  priceUsd: number;
  feeUsd: number;
  createdAt: number;
}
const PAPER_QUOTES_KEY = "__arenaPaperQuotes";
function paperQuotes(): Map<string, StoredPaperQuote> {
  const g = globalThis as Record<string, unknown>;
  if (!g[PAPER_QUOTES_KEY]) g[PAPER_QUOTES_KEY] = new Map<string, StoredPaperQuote>();
  return g[PAPER_QUOTES_KEY] as Map<string, StoredPaperQuote>;
}

/** Single use: returns the server-issued paper quote for this wallet and forgets it. */
export function consumePaperQuote(quoteId: string, funder: string): StoredPaperQuote {
  const store = paperQuotes();
  for (const [id, q] of store) if (Date.now() - q.createdAt > QUOTE_TTL_MS) store.delete(id);
  const q = store.get(quoteId);
  if (!q) throw new ApiError(404, "NOT_FOUND", "Paper quote not found or expired. Request a new quote.");
  if (q.funder !== funder.toLowerCase()) throw new ApiError(403, "FORBIDDEN", "This quote belongs to another wallet");
  store.delete(quoteId);
  return q;
}

function takeQuote(quoteId: string, funder: string, remove: boolean): StoredQuote {
  const store = quotes();
  for (const [id, q] of store) if (Date.now() - q.createdAt > QUOTE_TTL_MS) store.delete(id);
  const q = store.get(quoteId);
  if (!q) throw new ApiError(404, "NOT_FOUND", "Quote not found or expired. Request a new quote.");
  if (q.funder !== funder) throw new ApiError(403, "FORBIDDEN", "This quote belongs to another wallet");
  if (remove) store.delete(quoteId);
  return q;
}

// ---- Ticket mapping ----

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ApiError(422, "VALIDATION", `${name} must be a positive number`);
  }
  return v;
}

/** UI order types to the platform OrderIntent. Brackets on entries are attached legs. */
export function ticketToIntent(t: TicketInput): OrderIntent {
  const base = { side: t.side, asset: t.asset, quoteAsset: "USDC" as const, notionalUsd: num(t.sizeUsd, "sizeUsd") };
  const hasTp = t.takeProfitPrice !== undefined;
  const hasSl = t.stopLossPrice !== undefined;
  if (hasTp !== hasSl) throw new ApiError(422, "VALIDATION", "Set both take-profit and stop-loss, or neither");
  const attachedBracket = hasTp
    ? { takeProfitPrice: num(t.takeProfitPrice, "takeProfitPrice"), stopLossPrice: num(t.stopLossPrice, "stopLossPrice") }
    : undefined;

  switch (t.orderType) {
    case "market":
      return { ...base, orderType: "market", ...(attachedBracket ? { attachedBracket } : {}) };
    case "limit":
      return { ...base, orderType: "limit", limitPrice: num(t.limitPrice, "limitPrice"), ...(attachedBracket ? { attachedBracket } : {}) };
    case "bracket":
      if (!attachedBracket) throw new ApiError(422, "VALIDATION", "Bracket orders need take-profit and stop-loss prices");
      // Sell: Flash's standalone bracket closes an existing position at TP or SL (no limit price).
      // Buy: a limit entry with the TP/SL attached.
      if (t.side === "sell") return { ...base, orderType: "bracket", attachedBracket };
      return { ...base, orderType: "limit", limitPrice: num(t.limitPrice, "limitPrice"), attachedBracket };
    case "twap": {
      const durationMin = num(t.twap?.durationMin, "TWAP duration");
      const buckets = num(t.twap?.buckets, "TWAP buckets");
      return {
        ...base,
        orderType: "twap",
        twap: { durationSeconds: Math.max(300, Math.round(durationMin * 60)), bucketCount: Math.round(buckets) },
        ...(attachedBracket ? { attachedBracket } : {}),
      };
    }
    case "stop":
      return { ...base, orderType: "stop", triggerPrice: num(t.triggerPrice, "triggerPrice") };
    case "trailing":
      return { ...base, orderType: "trailing-stop", trailPercent: num(t.trailPct, "trailPct") };
    default:
      throw new ApiError(422, "VALIDATION", "Unknown order type");
  }
}

function assertTicketLimits(t: TicketInput): void {
  const e = env();
  if (!(t.sizeUsd >= e.MIN_ORDER_USD) || t.sizeUsd > e.MAX_TRADE_USD) {
    throw new ApiError(
      422,
      "VALIDATION",
      `Size must be between $${e.MIN_ORDER_USD} (MIN_ORDER_USD) and $${e.MAX_TRADE_USD} (MAX_TRADE_USD)`,
    );
  }
  if (!e.ALLOWED_TOKENS.includes(t.asset)) throw new ApiError(422, "VALIDATION", `${t.asset} is not on the platform allowlist`);
}

function parseTyped(raw: string | null | undefined, what: string): TypedDataJson {
  if (!raw) throw new ApiError(502, "UPSTREAM", `Flash quote is missing ${what}`);
  return JSON.parse(raw) as TypedDataJson;
}

function fromPermitOrNull(raw: string | null | undefined): TypedDataJson | null {
  return raw ? (JSON.parse(raw) as TypedDataJson) : null;
}

// ---- Quote ----

/**
 * Paper mode. With a Flash key, prices the simulated fill from a real Flash quote (same request a live order
 * would send, so price, slippage and fees are real); nothing is signed or submitted. Without a key, or if the
 * quote fails, falls back to the mark price and says so in the note.
 */
async function paperQuote(ticket: TicketInput, funder: `0x${string}`, markPriceUsd: number, integratorFeeUsd: number): Promise<TradeQuote> {
  const e = env();
  const fallback = (why: string): TradeQuote => ({
    mode: "paper",
    notionalUsd: ticket.sizeUsd,
    priceUsd: markPriceUsd,
    feeUsd: integratorFeeUsd,
    note: `Paper mode: simulated fill at the mark price (${why}). Nothing was sent to Flash.`,
  });
  if (!e.DEFINITIVE_API_KEY) return fallback("no Flash key configured");
  let req: QuoteRequest;
  try {
    req = intentToQuoteRequest(ticketToIntent(ticket), {
      chain: "base",
      funderAddress: funder,
      integratorFeeBps: e.FLASH_INTEGRATOR_FEE_BPS,
      tokens: BASE_TOKENS,
      referencePriceUsd: markPriceUsd,
    });
  } catch (err) {
    if (err instanceof FlashMappingError) throw new ApiError(422, "VALIDATION", err.message);
    throw err;
  }
  let quote: QuoteResponse;
  try {
    quote = await flash().quote(req);
  } catch (err) {
    return fallback(`Flash quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const target = quote.from.asset === "target" ? quote.from : quote.to;
  const contra = quote.from.asset === "contra" ? quote.from : quote.to;
  const qty = Number(target.amount);
  const priceUsd = qty > 0 ? Number(contra.notional) / qty : markPriceUsd;
  const flashFeeUsd = Number(quote.fees.estimatedFeeNotional) || 0;
  paperQuotes().set(quote.quoteId, {
    funder: funder.toLowerCase(),
    side: ticket.side,
    asset: ticket.asset,
    orderType: ticket.orderType,
    notionalUsd: ticket.sizeUsd,
    priceUsd,
    feeUsd: integratorFeeUsd + flashFeeUsd,
    createdAt: Date.now(),
  });
  return {
    mode: "paper",
    notionalUsd: ticket.sizeUsd,
    priceUsd,
    feeUsd: integratorFeeUsd + flashFeeUsd,
    quoteId: quote.quoteId,
    priceImpact: quote.estimatedPriceImpact ?? null,
    note: `Paper mode: real Flash quote ${quote.quoteId.slice(0, 8)}…, simulated fill. Nothing was signed or submitted.`,
  };
}

export async function quoteTicket(input: { ticket: TicketInput; funder: `0x${string}`; markPriceUsd: number }): Promise<TradeQuote> {
  const { ticket, funder, markPriceUsd } = input;
  assertTicketLimits(ticket);
  const e = env();
  const feeUsd = (ticket.sizeUsd * e.FLASH_INTEGRATOR_FEE_BPS) / 10_000;

  if (!flashLive()) return paperQuote(ticket, funder, markPriceUsd, feeUsd);

  const intent = ticketToIntent(ticket);
  let req: QuoteRequest;
  try {
    req = intentToQuoteRequest(intent, {
      chain: "base",
      funderAddress: funder,
      integratorFeeBps: e.FLASH_INTEGRATOR_FEE_BPS,
      tokens: BASE_TOKENS,
      referencePriceUsd: markPriceUsd,
    });
  } catch (err) {
    if (err instanceof FlashMappingError) throw new ApiError(422, "VALIDATION", err.message);
    throw err;
  }

  let quote: QuoteResponse;
  try {
    quote = await flash().quote(req);
  } catch (err) {
    throw upstream(err);
  }

  quotes().set(quote.quoteId, { funder: funder.toLowerCase(), req, quote, notionalUsd: ticket.sizeUsd, createdAt: Date.now() });

  const approvals = approvalRequirements(quote);
  const steps: OnchainStep[] = [];
  if (approvals.approveTx) steps.push({ kind: "approve", to: approvals.approveTx.to, data: approvals.approveTx.data, value: "0" });
  if (approvals.wrapTx) steps.push({ kind: "wrap", to: approvals.wrapTx.to, data: approvals.wrapTx.data, value: approvals.wrapTx.value });
  for (const raw of approvals.setupTxs) steps.push({ kind: "setup", raw });
  if (approvals.bracketApproveTx) {
    steps.push({ kind: "bracket-approve", to: approvals.bracketApproveTx.to, data: approvals.bracketApproveTx.data, value: "0" });
  }

  const bracketEvm = quote.attachedBracket?.evm ?? null;
  return {
    mode: "live",
    quoteId: quote.quoteId,
    receive: { amount: quote.to.amount, asset: quote.to.asset },
    feeUsd,
    priceImpact: quote.estimatedPriceImpact ?? null,
    recommendedSlippage: quote.recommendedSlippage ?? null,
    steps,
    sign: {
      order: parseTyped(quote.evm?.orderTypedData, "evm.orderTypedData"),
      permit: fromPermitOrNull(approvals.permitTypedData),
      bracket: bracketEvm
        ? { order: parseTyped(bracketEvm.orderTypedData, "attachedBracket.evm.orderTypedData"), permit: fromPermitOrNull(bracketEvm.permitTypedData) }
        : null,
    },
  };
}

// ---- Order ----

export async function submitTicket(input: { quoteId: string; funder: `0x${string}`; signatures: OrderSignatures }): Promise<{ orderId: string; bracketStatus: string | null }> {
  if (!flashLive()) throw new ApiError(409, "UNAVAILABLE", "Paper mode: orders are never submitted");
  const stored = takeQuote(input.quoteId, input.funder.toLowerCase(), true);
  if (stored.notionalUsd > env().MAX_TRADE_USD) throw new ApiError(422, "VALIDATION", "Trade exceeds MAX_TRADE_USD");

  const s = input.signatures;
  let body;
  try {
    body = buildOrderRequest(stored.req, stored.quote, {
      userSignature: s.order,
      ...(s.permit ? { evmPermitSignature: s.permit } : {}),
      ...(s.bracketOrder
        ? { attachedBracket: { userSignature: s.bracketOrder, ...(s.bracketPermit ? { evmPermitSignature: s.bracketPermit } : {}) } }
        : {}),
    });
  } catch (err) {
    if (err instanceof FlashMappingError) throw new ApiError(422, "VALIDATION", err.message);
    throw err;
  }

  try {
    const res = await flash().submitOrder(body);
    return { orderId: res.orderId, bracketStatus: res.attachedBracket?.status ?? null };
  } catch (err) {
    throw upstream(err);
  }
}

function upstream(err: unknown): ApiError {
  if (err instanceof FlashApiError) {
    const status = err.status === 429 ? 429 : 502;
    return new ApiError(status, "UPSTREAM", `Flash: ${err.message}`);
  }
  return new ApiError(502, "UPSTREAM", "Flash request failed");
}

// ---- Cancels: the server states the exact message, the funder wallet signs it, the server checks it ----

/** Flash accepts at most 25 ids per batch cancel. */
const MAX_CANCEL_IDS = 25;
/** Paper ids are local labels such as "ord_7f3a21". They never reach Flash. */
const PAPER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 1 to 25 unique ids. Live ids must be lowercase UUIDs, the form Flash signs. */
export function parseCancelIds(v: unknown, live: boolean): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CANCEL_IDS) {
    throw new ApiError(422, "VALIDATION", `orderIds must be an array of 1 to ${MAX_CANCEL_IDS} ids`);
  }
  const ids = v.map((x: unknown) => {
    const ok = typeof x === "string" && (live ? ORDER_ID_PATTERN.test(x) : PAPER_ID.test(x));
    if (!ok) throw new ApiError(422, "VALIDATION", live ? "orderIds must be lowercase order UUIDs" : "orderIds are invalid");
    return x as string;
  });
  if (new Set(ids).size !== ids.length) throw new ApiError(422, "VALIDATION", "orderIds must be unique");
  return ids;
}

/** One id uses the single-cancel message. Two or more use the batch message. */
function cancelMessageFor(orderIds: string[]): string {
  try {
    return orderIds.length === 1 ? buildCancelMessage(orderIds[0]!) : buildBatchCancelMessage(orderIds);
  } catch (err) {
    throw new ApiError(422, "VALIDATION", err instanceof Error ? err.message : "Invalid order ids");
  }
}

/** Paper mode: nothing is sent, so there is nothing to sign. Live: the exact message the funder must sign. */
export function planCancel(orderIds: string[]): CancelPlan {
  if (!flashLive()) return { mode: "paper", orderIds };
  return { mode: "live", orderIds, message: cancelMessageFor(orderIds) };
}

/**
 * Sends a signed cancel to Flash after checking that the message is the one this server would have issued for
 * these ids, and that the signature recovers to the signed-in funder. Flash still checks the signature and the
 * ownership of each order.
 */
export async function submitCancel(input: {
  orderIds: string[];
  message: string;
  signature: `0x${string}`;
  funder: `0x${string}`;
}): Promise<CancelResult[]> {
  if (!flashLive()) throw new ApiError(409, "UNAVAILABLE", "Paper mode: cancels are never sent to Flash");
  if (input.message !== cancelMessageFor(input.orderIds)) {
    throw new ApiError(422, "VALIDATION", "The signed message does not match these orders. Start the cancel again.");
  }
  const signedByFunder = await verifyMessage({
    address: input.funder,
    message: input.message,
    signature: input.signature,
  }).catch(() => false);
  if (!signedByFunder) throw new ApiError(401, "UNAUTHENTICATED", "The signature does not match the signed-in wallet");

  const c = flash();
  try {
    if (input.orderIds.length === 1) {
      const orderId = input.orderIds[0]!;
      try {
        await c.cancelOrder(orderId, { cancelMessage: input.message, userSignature: input.signature });
        return [{ orderId, ok: true, errorCode: null }];
      } catch (err) {
        // A rejected single cancel is a per-order result, the same shape a batch returns.
        if (err instanceof FlashApiError) return [{ orderId, ok: false, errorCode: err.code }];
        throw err;
      }
    }
    const res = await c.batchCancel({ orderIds: input.orderIds, cancelMessage: input.message, userSignature: input.signature });
    return res.results.map((r) => ({
      orderId: r.orderId,
      ok: r.ok,
      errorCode: r.ok ? null : (r.errorCode ?? "UNKNOWN"),
    }));
  } catch (err) {
    throw upstream(err);
  }
}

// ---- Activity (open orders, fills, balances) for one funder ----

const OPEN = new Set(["ORDER_STATUS_PENDING", "ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PARTIALLY_FILLED"]);
const fillCache = new Map<string, Fill[]>();
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export async function flashActivity(funder: `0x${string}`): Promise<TradingActivity> {
  const c = flash();
  const list = await c.listOrders({ funderAddress: funder, pageSize: 50 }).catch((err: unknown) => {
    throw upstream(err);
  });

  const openOrders: OpenOrder[] = list.orders.filter((o) => OPEN.has(o.status)).map(toOpenOrder);

  const filled = list.orders.filter((o) => o.status === "ORDER_STATUS_FILLED" || o.status === "ORDER_STATUS_PARTIALLY_FILLED");
  const fills: Fill[] = [];
  for (const o of filled.slice(0, 10)) {
    const cached = fillCache.get(o.orderId);
    if (cached) {
      fills.push(...cached);
      continue;
    }
    const detail = await c.getOrder(o.orderId, funder).catch(() => null);
    if (!detail) continue;
    const rows = detail.fills
      .map((f) => toFill(f, detail.order.side, detail.order.targetAsset.ticker))
      .filter((f): f is Fill => f !== null);
    // Filled orders do not change, so their fills can be cached for the process lifetime.
    if (o.status === "ORDER_STATUS_FILLED") fillCache.set(o.orderId, rows);
    fills.push(...rows);
  }
  fills.sort((a, b) => b.ts - a.ts);

  const balances: Balance[] = await c
    .balances(funder)
    .then((r) =>
      r.balances.map((b) => {
        const amount = Number(b.balance) / 10 ** b.tokenDecimals;
        return { symbol: b.symbol, amount, valueUsd: Number(b.notional) };
      }),
    )
    .catch(() => []);

  return { source: "flash", openOrders, fills, balances };
}

function toOpenOrder(o: FlashOrder): OpenOrder {
  const price = Number(o.limitNotionalPrice ?? o.trigger?.notionalPrice ?? 0);
  const qty = Number(o.qty);
  const sizeUsd = o.side === "buy" ? qty : qty * price;
  return {
    id: o.orderId,
    ts: Date.parse(o.placedAt) || 0,
    asset: o.targetAsset.ticker,
    side: o.side,
    orderType: o.orderType as OpenOrder["orderType"],
    sizeUsd: Number.isFinite(sizeUsd) ? sizeUsd : 0,
    priceUsd: Number.isFinite(price) ? price : 0,
    status: o.status === "ORDER_STATUS_PARTIALLY_FILLED" ? "partially_filled" : "open",
  };
}

function toFill(f: FlashFill, side: "buy" | "sell", asset: string): Fill | null {
  if (!TX_HASH.test(f.transactionId)) return null;
  return {
    id: `${f.orderId}:${f.transactionId}`,
    ts: Date.parse(f.filledAt) || 0,
    asset,
    side,
    sizeUsd: Number(f.notional),
    priceUsd: Number(f.fillPrice),
    feeUsd: Number(f.feeNotional),
    txHash: f.transactionId as `0x${string}`,
  };
}

