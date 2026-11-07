"use client";

// One shared WebSocket to the Coinbase Exchange public feed (ticker channel, no auth), used by every /trade
// component. Products are reference-counted: acquire() subscribes on demand and the returned release() unsubscribes.
// The socket closes after a short idle grace period once nothing is subscribed. Tick state lives in a plain store so
// React reads it through useSyncExternalStore and chart code can subscribe without re-rendering.
//
// Reconnects use exponential backoff with jitter. A socket that stays silent for 30 s is torn down and retried.
// While the socket is down, the markets query (GET /api/markets) keeps prices fresh by polling.

import type { MarketStats } from "@/lib/live/types";

export const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";

const CONNECT_TIMEOUT_MS = 10_000;
const SILENCE_TIMEOUT_MS = 30_000;
const CHECK_INTERVAL_MS = 3_000;
const IDLE_CLOSE_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;
/** A ws ticker newer than this is never overwritten by a REST seed. */
const WS_FRESH_MS = 20_000;

export type FeedStatus = "idle" | "connecting" | "open" | "down";
export type Direction = "up" | "down" | "flat";

export interface Ticker {
  product: string;
  price: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  bid: number | null;
  ask: number | null;
  change24hPct: number;
  /** Direction of the last price change, kept across equal prices so colours do not flicker. */
  dir: Direction;
  /** Size of the most recent trade. 0 for REST seeds. */
  lastSize: number;
  /** Event time in ms (exchange clock for ws, server fetch time for REST). */
  ts: number;
  /** Local receipt time, used for freshness. */
  recvAt: number;
  source: "ws" | "rest";
}

type Listener = () => void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const pct = (price: number, open: number): number => (open > 0 ? ((price - open) / open) * 100 : 0);

class CoinbaseFeed {
  private ws: WebSocket | null = null;
  private status: FeedStatus = "idle";
  private wanted = new Map<string, number>();
  private sent = new Set<string>();
  /** Products Coinbase refused (delisted). Never subscribed again, so one bad product cannot block the others. */
  private rejected = new Set<string>();
  private tickers = new Map<string, Ticker>();
  private productListeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<Listener>();
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private connectStartedAt = 0;
  private lastMessageAt = 0;
  private warned = false;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.reconnectNow());
    }
  }

  // ---- consumers ----

  /** Subscribes to ticker updates for these products. Returns a release function. */
  acquire(products: readonly string[]): () => void {
    for (const p of products) this.wanted.set(p, (this.wanted.get(p) ?? 0) + 1);
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.ws) this.connect();
    this.syncSubscriptions();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(products);
    };
  }

  private release(products: readonly string[]): void {
    for (const p of products) {
      const n = (this.wanted.get(p) ?? 0) - 1;
      if (n > 0) this.wanted.set(p, n);
      else this.wanted.delete(p);
    }
    this.syncSubscriptions();
    if (this.wanted.size === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.closeSocket(), IDLE_CLOSE_MS);
    }
  }

  getTicker(product: string): Ticker | null {
    return this.tickers.get(product) ?? null;
  }

  /** Called after every update to this product (ws tick or REST seed). */
  subscribeTicker(product: string, listener: Listener): () => void {
    let set = this.productListeners.get(product);
    if (!set) {
      set = new Set();
      this.productListeners.set(product, set);
    }
    set.add(listener);
    return () => {
      this.productListeners.get(product)?.delete(listener);
    };
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  subscribeStatus(listener: Listener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Applies REST stats as prices. A REST value never overrides a ws ticker that arrived recently, because the socket
   * is fresher. It does fill in when the socket is quiet or down.
   */
  seed(rows: readonly MarketStats[]): void {
    const now = Date.now();
    for (const r of rows) {
      const prev = this.tickers.get(r.product);
      if (prev && prev.source === "ws" && now - prev.recvAt < WS_FRESH_MS) continue;
      const dir: Direction = !prev || r.priceUsd === prev.price ? (prev?.dir ?? "flat") : r.priceUsd > prev.price ? "up" : "down";
      this.put({
        product: r.product,
        price: r.priceUsd,
        open24h: r.open24h,
        high24h: r.high24h,
        low24h: r.low24h,
        volume24h: r.volume24h,
        bid: null,
        ask: null,
        change24hPct: pct(r.priceUsd, r.open24h),
        dir,
        lastSize: 0,
        ts: r.ts,
        recvAt: now,
        source: "rest",
      });
    }
  }

  // ---- socket lifecycle ----

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(COINBASE_WS_URL);
    } catch {
      this.fail();
      return;
    }
    this.ws = ws;
    this.sent = new Set();
    this.connectStartedAt = Date.now();
    this.setStatus("connecting");
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (!this.checkTimer) this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.setStatus("open");
      this.syncSubscriptions();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.handle(ev.data);
    };
    ws.onerror = () => {
      if (this.ws === ws) this.fail();
    };
    ws.onclose = () => {
      if (this.ws === ws) this.fail();
    };
  }

  /** Drops the current socket and schedules a retry (or goes idle when nothing is subscribed). */
  private fail(): void {
    const ws = this.ws;
    this.ws = null;
    this.sent = new Set();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Already closed or closing.
      }
    }
    if (this.wanted.size === 0) {
      this.closeSocket();
      return;
    }
    this.setStatus("down");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.attempts);
    this.attempts += 1;
    const delay = base * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wanted.size > 0 && !this.ws) this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.wanted.size === 0 || this.ws) return;
    this.attempts = 0;
    this.connect();
  }

  /** Watchdog: a connect that never opens, or an open socket that has gone silent, is torn down and retried. */
  private check(): void {
    const ws = this.ws;
    if (!ws) return;
    const now = Date.now();
    if (ws.readyState === WebSocket.CONNECTING && now - this.connectStartedAt > CONNECT_TIMEOUT_MS) this.fail();
    else if (ws.readyState === WebSocket.OPEN && now - this.lastMessageAt > SILENCE_TIMEOUT_MS) this.fail();
  }

  /** Tears the socket down for good and returns to idle. Tickers stay cached for the next acquire. */
  private closeSocket(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    this.retryTimer = undefined;
    this.idleTimer = undefined;
    clearInterval(this.checkTimer);
    this.checkTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    this.sent = new Set();
    this.attempts = 0;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Already closed or closing.
      }
    }
    this.setStatus("idle");
  }

  /**
   * Sends subscribe/unsubscribe so the socket matches the wanted set. No-op until the socket is open. One message per
   * product: Coinbase rejects a whole subscribe message if any product in it is refused.
   */
  private syncSubscriptions(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const add = [...this.wanted.keys()].filter((p) => !this.sent.has(p) && !this.rejected.has(p));
    const drop = [...this.sent].filter((p) => !this.wanted.has(p));
    try {
      for (const p of add) {
        ws.send(JSON.stringify({ type: "subscribe", product_ids: [p], channels: ["ticker"] }));
        this.sent.add(p);
      }
      for (const p of drop) {
        ws.send(JSON.stringify({ type: "unsubscribe", product_ids: [p], channels: ["ticker"] }));
        this.sent.delete(p);
      }
    } catch {
      // The socket is closing. onclose will fail() and resubscribe on the next connection.
    }
  }

  // ---- messages ----

  private handle(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.type === "ticker") this.applyTicker(msg);
    else if (msg.type === "error") this.applyError(msg);
  }

  /** A refused product (e.g. delisted) is dropped for this page load. Other products are unaffected. */
  private applyError(msg: Record<string, unknown>): void {
    const text = String(msg.reason ?? msg.message ?? "");
    const product = /\b([A-Z0-9]+-[A-Z0-9]+)\b/.exec(text)?.[1];
    if (product && this.wanted.has(product) && !this.rejected.has(product)) {
      this.rejected.add(product);
      this.sent.delete(product);
      console.warn(`[arena] Coinbase feed skipped ${product}: ${text}`);
    } else if (!this.warned) {
      this.warned = true;
      console.warn("[arena] Coinbase feed error:", text || "unknown");
    }
  }

  private applyTicker(m: Record<string, unknown>): void {
    const product = typeof m.product_id === "string" ? m.product_id : null;
    if (!product || !this.wanted.has(product)) return;
    const price = num(m.price);
    if (price === null || price <= 0) return;
    const prev = this.tickers.get(product);
    const open24h = num(m.open_24h) ?? prev?.open24h ?? price;
    const eventTs = typeof m.time === "string" ? Date.parse(m.time) : NaN;
    const dir: Direction = !prev || price === prev.price ? (prev?.dir ?? "flat") : price > prev.price ? "up" : "down";
    this.put({
      product,
      price,
      open24h,
      high24h: num(m.high_24h) ?? prev?.high24h ?? price,
      low24h: num(m.low_24h) ?? prev?.low24h ?? price,
      volume24h: num(m.volume_24h) ?? prev?.volume24h ?? 0,
      bid: num(m.best_bid) ?? prev?.bid ?? null,
      ask: num(m.best_ask) ?? prev?.ask ?? null,
      change24hPct: pct(price, open24h),
      dir,
      lastSize: num(m.last_size) ?? 0,
      ts: Number.isFinite(eventTs) ? eventTs : Date.now(),
      recvAt: Date.now(),
      source: "ws",
    });
  }

  // ---- store ----

  private put(t: Ticker): void {
    this.tickers.set(t.product, t);
    const set = this.productListeners.get(t.product);
    if (set) for (const l of set) l();
  }

  private setStatus(next: FeedStatus): void {
    if (next === this.status) return;
    this.status = next;
    for (const l of this.statusListeners) l();
  }
}

/** Module singleton. Nothing connects until a component calls acquire() in an effect, so SSR never opens a socket. */
export const coinbaseFeed = new CoinbaseFeed();
