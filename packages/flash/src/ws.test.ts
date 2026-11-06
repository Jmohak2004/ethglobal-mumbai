import { describe, expect, it } from "bun:test";
import { FlashOrderStream, type WebSocketLike } from "./ws.ts";
import { FUNDER, ORDER_ID, orderFixture } from "./test-helpers.ts";

const FUNDER_B = "0x1111111111111111111111111111111111111111";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
  open(): void {
    this.onopen?.({});
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Simulates a server-side drop (no client-initiated close). */
  drop(): void {
    this.closed = true;
    this.onclose?.({ code: 1006 });
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const order = (status: string, extra: Record<string, unknown> = {}) =>
  ({ ...orderFixture({ status: status as never }), ...extra });

function setup(over: { funderAddresses?: string[] } = {}) {
  FakeSocket.instances = [];
  const snapshots: { funderAddress: string; orders: unknown[] }[] = [];
  const updates: { funderAddress: string; orders: unknown[] }[] = [];
  const errors: { code: string | null; fatal: boolean }[] = [];
  const stream = new FlashOrderStream({
    apiKey: "test-key-not-real",
    funderAddresses: over.funderAddresses ?? [FUNDER],
    url: "wss://test.invalid/v1/ws",
    WebSocketImpl: FakeSocket,
    onSnapshot: (e) => snapshots.push(e),
    onUpdate: (e) => updates.push(e),
    onError: (e) => errors.push({ code: e.code, fatal: e.fatal }),
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    random: () => 0,
    heartbeatTimeoutMs: 60_000,
  });
  return { stream, snapshots, updates, errors };
}

describe("FlashOrderStream", () => {
  it("subscribes to orders (with funderAddress) and heartbeats, with apiKey in the body, on open", () => {
    const { stream } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    expect(sock.url).toBe("wss://test.invalid/v1/ws");
    sock.open();
    expect(sock.sent).toEqual([
      { channel: "orders", type: "subscribe", funderAddress: FUNDER, apiKey: "test-key-not-real" },
      { channel: "heartbeats", type: "subscribe", apiKey: "test-key-not-real" },
    ]);
    stream.stop();
  });

  it("opens one socket per funder, since a connection holds one funder scope", () => {
    const { stream } = setup({ funderAddresses: [FUNDER, FUNDER_B] });
    stream.start();
    expect(FakeSocket.instances).toHaveLength(2);
    for (const s of FakeSocket.instances) s.open();
    const funders = FakeSocket.instances.map((s) => (s.sent[0] as { funderAddress: string }).funderAddress);
    expect(funders.sort()).toEqual([FUNDER, FUNDER_B].sort());
    stream.stop();
  });

  it("snapshot seeds the open-order cache; updates merge by orderId; terminal orders are removed", () => {
    const { stream, snapshots, updates } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.receive({ channel: "subscriptions", type: "ack", subscriptions: ["orders"] });
    sock.receive({ channel: "orders", type: "snapshot", orders: [order("ORDER_STATUS_ACCEPTED", { orderId: ORDER_ID })] });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.funderAddress).toBe(FUNDER);
    expect(stream.openOrders().map((o) => o.orderId)).toEqual([ORDER_ID]);

    sock.receive({ channel: "heartbeats", type: "heartbeat" });
    sock.receive({ channel: "orders", type: "update", orders: [order("ORDER_STATUS_PARTIALLY_FILLED", { orderId: ORDER_ID })] });
    expect(stream.openOrders()[0]!.status).toBe("ORDER_STATUS_PARTIALLY_FILLED");

    sock.receive({ channel: "orders", type: "update", orders: [order("ORDER_STATUS_FILLED", { orderId: ORDER_ID })] });
    expect(stream.openOrders()).toHaveLength(0);
    expect(updates).toHaveLength(2);
    stream.stop();
  });

  it("reconnects after a drop with backoff, re-subscribes, and the new snapshot resyncs state", async () => {
    const { stream } = setup();
    stream.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive({ channel: "orders", type: "snapshot", orders: [order("ORDER_STATUS_ACCEPTED", { orderId: ORDER_ID })] });
    expect(stream.openOrders()).toHaveLength(1);

    first.drop();
    await wait(30);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent[0]).toMatchObject({ channel: "orders", type: "subscribe", funderAddress: FUNDER });

    // The order disappeared while we were disconnected. The fresh snapshot must drop it.
    second.receive({ channel: "orders", type: "snapshot", orders: [] });
    expect(stream.openOrders()).toHaveLength(0);
    stream.stop();
  });

  it("UNAUTHORIZED is fatal: reported, and the connection is not retried", async () => {
    const { stream, errors } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.receive({ type: "error", code: "UNAUTHORIZED", message: "bad key" });
    expect(errors).toEqual([{ code: "UNAUTHORIZED", fatal: true }]);
    sock.drop();
    await wait(30);
    expect(FakeSocket.instances).toHaveLength(1);
    stream.stop();
  });

  it("transient errors are reported as non-fatal and the stream reconnects after a drop", async () => {
    const { stream, errors } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.receive({ type: "error", code: "STREAMING_UNAVAILABLE", message: "try later" });
    expect(errors).toEqual([{ code: "STREAMING_UNAVAILABLE", fatal: false }]);
    sock.drop();
    await wait(30);
    expect(FakeSocket.instances).toHaveLength(2);
    stream.stop();
  });

  it("stop() closes sockets and prevents reconnect", async () => {
    const { stream } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    stream.stop();
    expect(sock.closed).toBe(true);
    await wait(30);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("a non-JSON frame is reported as a non-fatal error and does not throw", () => {
    const { stream, errors } = setup();
    stream.start();
    const sock = FakeSocket.instances[0]!;
    sock.open();
    sock.onmessage?.({ data: "not json" });
    expect(errors).toEqual([{ code: null, fatal: false }]);
    stream.stop();
  });
});
