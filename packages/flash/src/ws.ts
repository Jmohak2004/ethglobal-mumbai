// Orders WebSocket client for Flash (wss://flash.definitive.fi/v1/ws).
//
// Docs-driven behavior:
// - Auth is the `apiKey` field in the subscribe message body. Browsers and the global WebSocket cannot set headers.
// - A connection holds one funder scope, so FlashOrderStream opens one socket per funderAddress.
// - Subscribe the `orders` channel (with funderAddress) and the `heartbeats` channel on every connection.
// - Every subscribe returns a fresh `snapshot`. It replaces the cached orders for that funder (resync).
// - `update` frames carry the full order state, keyed by orderId. Terminal statuses are removed from the cache.
// - Reconnect with exponential backoff (equal jitter, capped). Don't retry UNAUTHORIZED or INVALID_REQUEST.
//   Transient codes (STREAMING_UNAVAILABLE, FUNDER_LOCKED, others) reconnect and re-subscribe.

import { FLASH_WS_URL } from "@arena/shared";
import {
  OPEN_ORDER_STATUSES,
  WsErrorFrameSchema,
  WsSnapshotFrameSchema,
  WsUpdateFrameSchema,
  type FlashOrderUpdate,
} from "./types.ts";

/** Minimal WebSocket surface used here. The global WebSocket (Bun, Node 22+) satisfies it. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface OrderEvent {
  funderAddress: string;
  orders: FlashOrderUpdate[];
}

export interface StreamError {
  funderAddress: string | null;
  code: string | null;
  message: string;
  /** True when the connection for this funder has stopped and will not reconnect. */
  fatal: boolean;
}

export interface FlashOrderStreamOptions {
  apiKey: string;
  /** One socket is opened per funder. */
  funderAddresses: string[];
  /** Defaults to FLASH_WS_URL from @arena/shared. */
  url?: string;
  onSnapshot?: (event: OrderEvent) => void;
  onUpdate?: (event: OrderEvent) => void;
  onError?: (event: StreamError) => void;
  /** Injectable for tests. Defaults to the global WebSocket. */
  WebSocketImpl?: WebSocketCtor;
  /** Reconnect if no frame arrives within this window. Default 60 s. */
  heartbeatTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Random source in [0, 1) for jitter. */
  random?: () => number;
}

const FATAL_CODES = new Set(["UNAUTHORIZED", "INVALID_REQUEST"]);

export class FlashOrderStream {
  private readonly opts: Required<
    Pick<FlashOrderStreamOptions, "apiKey" | "url" | "heartbeatTimeoutMs" | "backoffBaseMs" | "backoffMaxMs" | "random">
  > &
    FlashOrderStreamOptions;
  private readonly WS: WebSocketCtor;
  private readonly connections = new Map<string, FunderConnection>();
  /** Open orders across all funders, keyed by orderId. */
  private readonly cache = new Map<string, FlashOrderUpdate>();
  private running = false;

  constructor(opts: FlashOrderStreamOptions) {
    if (!opts.apiKey) throw new Error("FlashOrderStream: apiKey is required");
    if (opts.funderAddresses.length === 0) throw new Error("FlashOrderStream: at least one funderAddress is required");
    this.opts = {
      ...opts,
      url: opts.url ?? FLASH_WS_URL,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 60_000,
      backoffBaseMs: opts.backoffBaseMs ?? 1_000,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
      random: opts.random ?? Math.random,
    };
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    if (!this.WS) throw new Error("FlashOrderStream: no WebSocket implementation available");
    for (const f of new Set(opts.funderAddresses)) {
      this.connections.set(f, new FunderConnection(this, f));
    }
  }

  /** Opens one connection per funder. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const c of this.connections.values()) c.connect();
  }

  /** Closes all sockets and cancels timers. */
  stop(): void {
    this.running = false;
    for (const c of this.connections.values()) c.dispose();
  }

  /** Current open orders across funders (terminal orders removed). */
  openOrders(): FlashOrderUpdate[] {
    return [...this.cache.values()];
  }

  /** @internal */
  get internals() {
    return {
      WS: this.WS,
      opts: this.opts,
      cache: this.cache,
      isRunning: () => this.running,
    };
  }
}

class FunderConnection {
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly stream: FlashOrderStream,
    private readonly funderAddress: string,
  ) {}

  private get cfg() {
    return this.stream.internals;
  }

  connect(): void {
    if (this.disposed || !this.cfg.isRunning()) return;
    const { WS, opts } = this.cfg;
    const socket = new WS(opts.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.send({ channel: "orders", type: "subscribe", funderAddress: this.funderAddress, apiKey: opts.apiKey });
      this.send({ channel: "heartbeats", type: "subscribe", apiKey: opts.apiKey });
      this.armWatchdog();
    };
    socket.onmessage = (ev) => {
      this.armWatchdog();
      if (typeof ev.data === "string") this.handleFrame(ev.data);
    };
    socket.onerror = () => {
      // Transport errors are followed by onclose, which handles reconnect.
    };
    socket.onclose = () => {
      this.clearWatchdog();
      this.socket = null;
      if (this.disposed || !this.cfg.isRunning()) return;
      this.scheduleReconnect();
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearWatchdog();
    const s = this.socket;
    this.socket = null;
    s?.close(1000, "client stop");
  }

  private send(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private handleFrame(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.emitError({ code: null, message: "non-JSON frame", fatal: false });
      return;
    }
    if (typeof json !== "object" || json === null) return;
    const frame = json as Record<string, unknown>;

    if (frame.type === "error") {
      const parsed = WsErrorFrameSchema.safeParse(frame);
      const code = parsed.success ? parsed.data.code : null;
      const message = parsed.success ? parsed.data.message : "stream error";
      const fatal = code !== null && FATAL_CODES.has(code);
      this.emitError({ code, message, fatal });
      if (fatal) {
        this.disposed = true;
        this.clearWatchdog();
        this.socket?.close(1000, code ?? "fatal");
        this.socket = null;
      }
      return;
    }

    if (frame.channel === "orders" && frame.type === "snapshot") {
      const parsed = WsSnapshotFrameSchema.safeParse(frame);
      if (!parsed.success) return this.emitError({ code: null, message: "invalid snapshot frame", fatal: false });
      this.resync(parsed.data.orders);
      this.stream.internals.opts.onSnapshot?.({ funderAddress: this.funderAddress, orders: parsed.data.orders });
      return;
    }

    if (frame.channel === "orders" && frame.type === "update") {
      const parsed = WsUpdateFrameSchema.safeParse(frame);
      if (!parsed.success) return this.emitError({ code: null, message: "invalid update frame", fatal: false });
      for (const o of parsed.data.orders) this.applyOrder(o);
      this.stream.internals.opts.onUpdate?.({ funderAddress: this.funderAddress, orders: parsed.data.orders });
      return;
    }

    // ack and heartbeat frames need no action beyond the watchdog reset above.
  }

  /** Snapshot replaces this funder's cached orders. */
  private resync(orders: FlashOrderUpdate[]): void {
    const cache = this.cfg.cache;
    for (const [id, o] of cache) {
      if (o.funderAddress === this.funderAddress) cache.delete(id);
    }
    for (const o of orders) this.applyOrder(o);
  }

  private applyOrder(o: FlashOrderUpdate): void {
    const cache = this.cfg.cache;
    if (OPEN_ORDER_STATUSES.includes(o.status)) cache.set(o.orderId, o);
    else cache.delete(o.orderId);
  }

  private emitError(e: { code: string | null; message: string; fatal: boolean }): void {
    this.cfg.opts.onError?.({ funderAddress: this.funderAddress, ...e });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const { backoffBaseMs, backoffMaxMs, random } = this.cfg.opts;
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (this.attempt - 1));
    const delay = exp / 2 + random() * (exp / 2); // equal jitter
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      // No frame in the window: treat the socket as dead. Closing triggers onclose, which reconnects.
      this.socket?.close(4000, "heartbeat timeout");
    }, this.cfg.opts.heartbeatTimeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
