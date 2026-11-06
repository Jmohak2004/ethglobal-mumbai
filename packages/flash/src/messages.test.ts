import { describe, expect, it } from "bun:test";
import { recoverMessageAddress, verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { FlashClient } from "./client.ts";
import {
  batchCancelSigned,
  buildBatchCancelMessage,
  buildCancelMessage,
  buildUpdateMessage,
  cancelOrderSigned,
  createOrderControl,
  localMessageSigner,
  updateOrderSigned,
  type MessageSigner,
  type UpdateOrderInput,
} from "./messages.ts";
import { FUNDER, ORDER_ID, fakeClock, mockFetch, orderFixture } from "./test-helpers.ts";

const KEY = "test-key-not-real";
const ID_A = ORDER_ID; // 6f1f3f0e-2a5b-4c1d-9d8e-111122223333
const ID_B = "0b7d2c1e-4f3a-4b5c-8d9e-aabbccddeeff";
const ISSUED = new Date("2026-11-07T00:10:00.123Z");
const UPDATE_HEAD = `Definitive Flash — Update Order\nOrder: ${ID_A}\nIssued At: 2026-11-07T00:10:00.123Z`;

function signerFor(): MessageSigner {
  return localMessageSigner(generatePrivateKey());
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe("buildCancelMessage", () => {
  it("matches the spec golden string byte for byte", () => {
    expect(buildCancelMessage(ID_A)).toBe("Definitive Flash v1 — Cancel Order\nOrder: 6f1f3f0e-2a5b-4c1d-9d8e-111122223333");
  });

  it("uses a real em dash (U+2014, UTF-8 e2 80 94), not a hyphen", () => {
    const bytes = new TextEncoder().encode(buildCancelMessage(ID_A));
    // "Definitive Flash v1 " is 20 ASCII bytes, so the dash starts at byte 20.
    expect([...bytes.subarray(20, 23)]).toEqual([0xe2, 0x80, 0x94]);
    // The title (first line) has no ASCII hyphen; the UUID on line two does, so check the title only.
    expect(buildCancelMessage(ID_A).split("\n")[0]).not.toContain("-");
  });

  it("has exactly two lines and no trailing newline", () => {
    const lines = buildCancelMessage(ID_A).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`Order: ${ID_A}`);
  });

  it("rejects uppercase, non-UUID and empty ids", () => {
    expect(() => buildCancelMessage(ID_A.toUpperCase())).toThrow(RangeError);
    expect(() => buildCancelMessage("ord_7f3a21")).toThrow(RangeError);
    expect(() => buildCancelMessage("")).toThrow(RangeError);
  });
});

describe("buildBatchCancelMessage", () => {
  it("matches the spec golden string: one lowercase UUID per line, no trailing newline", () => {
    expect(buildBatchCancelMessage([ID_A, ID_B])).toBe(
      "Definitive Flash v1 — Cancel Orders\nOrders:\n6f1f3f0e-2a5b-4c1d-9d8e-111122223333\n0b7d2c1e-4f3a-4b5c-8d9e-aabbccddeeff",
    );
  });

  it("keeps request order, not sorted order", () => {
    const msg = buildBatchCancelMessage([ID_B, ID_A]);
    expect(msg.split("\n").slice(2)).toEqual([ID_B, ID_A]);
  });

  it("accepts a single id and exactly 25 ids", () => {
    expect(buildBatchCancelMessage([ID_A])).toBe(`Definitive Flash v1 — Cancel Orders\nOrders:\n${ID_A}`);
    const many = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const msg = buildBatchCancelMessage(many);
    // Title line, "Orders:" line, then one line per id.
    expect(msg.split("\n")).toHaveLength(2 + 25);
    expect(msg.endsWith(many[24]!)).toBe(true);
  });

  it("rejects 0 ids and 26 ids", () => {
    expect(() => buildBatchCancelMessage([])).toThrow(/1 to 25/);
    const twentySix = Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => buildBatchCancelMessage(twentySix)).toThrow(/1 to 25/);
  });

  it("rejects duplicates, uppercase and malformed ids", () => {
    expect(() => buildBatchCancelMessage([ID_A, ID_A])).toThrow(/duplicate/);
    expect(() => buildBatchCancelMessage([ID_A, ID_A.toUpperCase()])).toThrow(RangeError);
    expect(() => buildBatchCancelMessage([ID_A, "not-an-id"])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("buildUpdateMessage", () => {
  it("limit cross price only: golden string and exact field", () => {
    const out = buildUpdateMessage({ orderId: ID_A, issuedAt: ISSUED, limitCrossPrice: "4000" });
    expect(out.message).toBe(`${UPDATE_HEAD}\nLimit Cross Price: 4000`);
    expect(out.fields).toEqual({ limitCrossPrice: "4000" });
  });

  it("limit notional price only, with the trailing zero kept (no normalization)", () => {
    const out = buildUpdateMessage({ orderId: ID_A, issuedAt: ISSUED, limitNotionalPrice: "4000.50" });
    expect(out.message).toBe(`${UPDATE_HEAD}\nLimit Notional Price: 4000.50`);
    expect(out.fields).toEqual({ limitNotionalPrice: "4000.50" });
  });

  it("trigger lower cross price only", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      trigger: { triggerType: "lower", crossPrice: "3500" },
    });
    expect(out.message).toBe(`${UPDATE_HEAD}\nTrigger Lower Cross Price: 3500`);
    expect(out.fields).toEqual({ trigger: { triggerType: "lower", crossPrice: "3500" } });
  });

  it("trigger upper notional price only", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      trigger: { triggerType: "upper", notionalPrice: "4500" },
    });
    expect(out.message).toBe(`${UPDATE_HEAD}\nTrigger Upper Notional Price: 4500`);
    expect(out.fields).toEqual({ trigger: { triggerType: "upper", notionalPrice: "4500" } });
  });

  it("limit and trigger together: limit line comes first", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      limitCrossPrice: "4000",
      trigger: { triggerType: "lower", crossPrice: "3500" },
    });
    expect(out.message).toBe(`${UPDATE_HEAD}\nLimit Cross Price: 4000\nTrigger Lower Cross Price: 3500`);
    expect(out.fields).toEqual({ limitCrossPrice: "4000", trigger: { triggerType: "lower", crossPrice: "3500" } });
  });

  it("limit notional with trigger upper cross: bases may differ between limit and trigger", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      limitNotionalPrice: "4100",
      trigger: { triggerType: "upper", crossPrice: "4500" },
    });
    expect(out.message).toBe(`${UPDATE_HEAD}\nLimit Notional Price: 4100\nTrigger Upper Cross Price: 4500`);
  });

  it("bracket: lower leg first even when given second, with a limit on the lower leg only", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      triggers: [
        { triggerType: "upper", notionalPrice: "4500" },
        { triggerType: "lower", notionalPrice: "3500", limitPrice: "3490" },
      ],
    });
    expect(out.message).toBe(
      `${UPDATE_HEAD}\nTrigger Lower Notional Price: 3500\nTrigger Lower Limit Price: 3490\nTrigger Upper Notional Price: 4500`,
    );
    expect(out.fields.triggers).toEqual([
      { triggerType: "lower", notionalPrice: "3500", limitPrice: "3490" },
      { triggerType: "upper", notionalPrice: "4500" },
    ]);
    expect(out.fields.triggers?.[1]).not.toHaveProperty("limitPrice");
  });

  it("bracket with cross legs and limits on both legs", () => {
    const out = buildUpdateMessage({
      orderId: ID_A,
      issuedAt: ISSUED,
      triggers: [
        { triggerType: "lower", crossPrice: "3000", limitPrice: "2990" },
        { triggerType: "upper", crossPrice: "4000", limitPrice: "4010" },
      ],
    });
    expect(out.message).toBe(
      `${UPDATE_HEAD}\nTrigger Lower Cross Price: 3000\nTrigger Lower Limit Price: 2990\nTrigger Upper Cross Price: 4000\nTrigger Upper Limit Price: 4010`,
    );
  });

  it("issuedAt is RFC3339 UTC with milliseconds by default from new Date()", () => {
    const out = buildUpdateMessage({ orderId: ID_A, issuedAt: new Date(0), limitCrossPrice: "1" });
    expect(out.message.split("\n")[2]).toBe("Issued At: 1970-01-01T00:00:00.000Z");
  });

  it("the em dash in the title is U+2014 and the title has no v1", () => {
    const first = buildUpdateMessage({ orderId: ID_A, issuedAt: ISSUED, limitCrossPrice: "1" }).message.split("\n")[0];
    expect(first).toBe("Definitive Flash — Update Order");
    expect(first).not.toContain("v1");
  });

  describe("rejects invalid input before anything is signed", () => {
    const base = { orderId: ID_A, issuedAt: ISSUED } as const;
    const bad = (input: Partial<UpdateOrderInput>) => () => buildUpdateMessage({ ...base, ...input } as UpdateOrderInput);

    it("requires at least one of limit, trigger or triggers", () => {
      expect(bad({})).toThrow(/needs a limit price, a trigger, or bracket triggers/);
    });

    it("allows only one limit basis", () => {
      expect(bad({ limitCrossPrice: "1", limitNotionalPrice: "2" })).toThrow(/not both/);
    });

    it("needs exactly one trigger price basis", () => {
      expect(bad({ trigger: { triggerType: "lower" } as never })).toThrow(/exactly one of crossPrice or notionalPrice/);
      expect(
        bad({ trigger: { triggerType: "lower", crossPrice: "1", notionalPrice: "1" } as never }),
      ).toThrow(/exactly one of crossPrice or notionalPrice/);
    });

    it("rejects an unknown trigger direction", () => {
      expect(bad({ trigger: { triggerType: "sideways", crossPrice: "1" } as never })).toThrow(/lower" or "upper/);
    });

    it("rejects non-positive and non-plain decimals", () => {
      for (const v of ["0", "0.0", "-5", "1e3", ".5", "4000.", " 4000", "4,000", "NaN", ""]) {
        expect(bad({ limitCrossPrice: v })).toThrow(/positive plain decimal/);
      }
      expect(bad({ limitCrossPrice: 4000 as unknown as string })).toThrow(/positive plain decimal/);
    });

    it("rejects an invalid issuedAt", () => {
      expect(() => buildUpdateMessage({ ...base, issuedAt: new Date("nope"), limitCrossPrice: "1" })).toThrow(/valid Date/);
    });

    it("rejects an uppercase order id", () => {
      expect(() => buildUpdateMessage({ ...base, orderId: ID_A.toUpperCase(), limitCrossPrice: "1" })).toThrow(RangeError);
    });

    it("bracket: no other fields, exactly one lower and one upper leg", () => {
      const legs = [
        { triggerType: "lower", notionalPrice: "3500" },
        { triggerType: "upper", notionalPrice: "4500" },
      ] as const;
      expect(bad({ triggers: legs, limitCrossPrice: "1" })).toThrow(/only triggers/);
      expect(bad({ triggers: legs, trigger: { triggerType: "lower", crossPrice: "1" } })).toThrow(/only triggers/);
      expect(bad({ triggers: [legs[0], { triggerType: "lower", notionalPrice: "3400" }] })).toThrow(/one lower leg and one upper/);
      expect(bad({ triggers: [legs[0]] as never })).toThrow(/exactly two legs/);
      expect(bad({ triggers: [legs[0], { triggerType: "upper", notionalPrice: "4500", limitPrice: "0" }] })).toThrow(
        /limitPrice/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

describe("localMessageSigner", () => {
  it("signs EIP-191 personal_sign: recovers to its own address over the exact message bytes", async () => {
    const pk = generatePrivateKey();
    const signer = localMessageSigner(pk);
    expect(signer.address).toBe(privateKeyToAccount(pk).address);

    const message = buildCancelMessage(ID_A);
    const signature = await signer.signMessage(message);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverMessageAddress({ message, signature })).toBe(signer.address);
    expect(await verifyMessage({ address: signer.address, message, signature })).toBe(true);
  });

  it("a hyphen in place of the em dash changes the signed bytes and fails verification", async () => {
    const signer = signerFor();
    const message = buildCancelMessage(ID_A);
    const signature = await signer.signMessage(message);
    const forged = message.replace("—", "-");
    expect(await verifyMessage({ address: signer.address, message: forged, signature })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signed requests: the bodies sent to Flash
// ---------------------------------------------------------------------------

describe("signed request bodies", () => {
  it("cancelOrderSigned: POST /orders/{id}/cancel with the signed cancelMessage", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }), fakeClock());
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });

    const res = await cancelOrderSigned(client, ID_A, signer);

    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe(`/v1/orders/${ID_A}/cancel`);
    expect(call.headers["x-definitive-api-key"]).toBe(KEY);
    const body = call.body as { cancelMessage: string; userSignature: string };
    expect(body.cancelMessage).toBe(`Definitive Flash v1 — Cancel Order\nOrder: ${ID_A}`);
    expect(Object.keys(body).sort()).toEqual(["cancelMessage", "userSignature"]);
    expect(await verifyMessage({ address: signer.address, message: body.cancelMessage, signature: body.userSignature as `0x${string}` })).toBe(true);
  });

  it("batchCancelSigned: POST /orders/cancel with ids, the batch message and one signature", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch(
      () => ({
        body: {
          results: [
            { orderId: ID_B, ok: true },
            { orderId: ID_A, ok: false, errorCode: "ALREADY_FILLED" },
          ],
        },
      }),
      fakeClock(),
    );
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });

    const res = await batchCancelSigned(client, [ID_B, ID_A], signer);

    expect(res.results).toEqual([
      { orderId: ID_B, ok: true },
      { orderId: ID_A, ok: false, errorCode: "ALREADY_FILLED" },
    ]);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v1/orders/cancel");
    const body = call.body as { orderIds: string[]; cancelMessage: string; userSignature: `0x${string}` };
    expect(body.orderIds).toEqual([ID_B, ID_A]);
    expect(body.cancelMessage).toBe(
      `Definitive Flash v1 — Cancel Orders\nOrders:\n${ID_B}\n${ID_A}`,
    );
    expect(await verifyMessage({ address: signer.address, message: body.cancelMessage, signature: body.userSignature })).toBe(true);
  });

  it("updateOrderSigned: PATCH /orders/{id} carries the signed updateMessage and the exact price strings", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }), fakeClock());
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });

    const res = await updateOrderSigned(
      client,
      { orderId: ID_A, issuedAt: ISSUED, limitNotionalPrice: "4000.50", trigger: { triggerType: "lower", notionalPrice: "3500" } },
      signer,
    );

    expect(res).toEqual({ ok: true });
    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(new URL(call.url).pathname).toBe(`/v1/orders/${ID_A}`);
    const body = call.body as Record<string, unknown> & { updateMessage: string; userSignature: `0x${string}` };
    expect(body.updateMessage).toBe(`${UPDATE_HEAD}\nLimit Notional Price: 4000.50\nTrigger Lower Notional Price: 3500`);
    expect(body.limitNotionalPrice).toBe("4000.50");
    expect(body.trigger).toEqual({ triggerType: "lower", notionalPrice: "3500" });
    expect(body).not.toHaveProperty("limitCrossPrice");
    expect(await verifyMessage({ address: signer.address, message: body.updateMessage, signature: body.userSignature })).toBe(true);
  });

  it("updateOrderSigned: bracket body sends legs lower first, matching the signed lines", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }), fakeClock());
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });

    await updateOrderSigned(
      client,
      {
        orderId: ID_A,
        issuedAt: ISSUED,
        triggers: [
          { triggerType: "upper", crossPrice: "4500" },
          { triggerType: "lower", crossPrice: "3500", limitPrice: "3490" },
        ],
      },
      signer,
    );

    const body = calls[0]!.body as { triggers: unknown[]; updateMessage: string };
    expect(body.triggers).toEqual([
      { triggerType: "lower", crossPrice: "3500", limitPrice: "3490" },
      { triggerType: "upper", crossPrice: "4500" },
    ]);
    expect(body.updateMessage.split("\n").slice(3)).toEqual([
      "Trigger Lower Cross Price: 3500",
      "Trigger Lower Limit Price: 3490",
      "Trigger Upper Cross Price: 4500",
    ]);
  });

  it("updateOrderSigned defaults issuedAt to now (RFC3339 with milliseconds)", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }), fakeClock());
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });
    await updateOrderSigned(client, { orderId: ID_A, limitCrossPrice: "4000" }, signer);
    const line = (calls[0]!.body as { updateMessage: string }).updateMessage.split("\n")[2]!;
    expect(line).toMatch(/^Issued At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("a signing failure sends nothing", async () => {
    const failing: MessageSigner = { address: FUNDER, signMessage: () => Promise.reject(new Error("User rejected")) };
    const { fetch, calls } = mockFetch(() => ({ body: { ok: true } }), fakeClock());
    const client = new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() });
    await expect(cancelOrderSigned(client, ID_A, failing)).rejects.toThrow("User rejected");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OrderControl
// ---------------------------------------------------------------------------

describe("createOrderControl", () => {
  it("cancel and cancelMany delegate to the signed helpers", async () => {
    const signer = signerFor();
    const { fetch, calls } = mockFetch((call) =>
      new URL(call.url).pathname.endsWith("/orders/cancel")
        ? { body: { results: [{ orderId: ID_A, ok: true }] } }
        : { body: { ok: true } },
    );
    const control = createOrderControl(new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() }), signer);

    await control.cancel(ID_A);
    const many = await control.cancelMany([ID_A]);

    expect(many.results).toEqual([{ orderId: ID_A, ok: true }]);
    expect(calls.map((c) => c.url.replace(/^.*\/v1/, ""))).toEqual([`/orders/${ID_A}/cancel`, "/orders/cancel"]);
  });

  it("tightenStop raises a lower trigger, keeping direction and basis, and signs only the trigger line", async () => {
    const signer = signerFor();
    const order = orderFixture({
      orderId: ID_A,
      orderType: "stop",
      trigger: { triggerType: "lower", notionalPrice: "3300" },
    });
    const { fetch, calls } = mockFetch((call) =>
      call.method === "GET" ? { body: { order, fills: [] } } : { body: { ok: true } },
    );
    const control = createOrderControl(new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() }), signer);

    await control.tightenStop(ID_A, "3400");

    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(new URL(calls[0]!.url).searchParams.get("funderAddress")).toBe(signer.address);
    const body = calls[1]!.body as { updateMessage: string; userSignature: `0x${string}`; trigger: unknown };
    expect(body.trigger).toEqual({ triggerType: "lower", notionalPrice: "3400" });
    expect(body.updateMessage.split("\n").slice(3)).toEqual(["Trigger Lower Notional Price: 3400"]);
    expect(await verifyMessage({ address: signer.address, message: body.updateMessage, signature: body.userSignature })).toBe(true);
  });

  it("tightenStop lowers an upper trigger on a cross basis", async () => {
    const signer = signerFor();
    const order = orderFixture({ orderId: ID_A, orderType: "stop", side: "sell", trigger: { triggerType: "upper", crossPrice: "4500" } });
    const { fetch, calls } = mockFetch((call) =>
      call.method === "GET" ? { body: { order, fills: [] } } : { body: { ok: true } },
    );
    const control = createOrderControl(new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() }), signer);

    await control.tightenStop(ID_A, "4400");
    expect((calls[1]!.body as { trigger: unknown }).trigger).toEqual({ triggerType: "upper", crossPrice: "4400" });
  });

  it("tightenStop refuses a looser or equal stop before signing or sending a PATCH", async () => {
    const signer = signerFor();
    const order = orderFixture({ orderId: ID_A, orderType: "stop", trigger: { triggerType: "lower", notionalPrice: "3300" } });
    const { fetch, calls } = mockFetch((call) =>
      call.method === "GET" ? { body: { order, fills: [] } } : { body: { ok: true } },
    );
    const control = createOrderControl(new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() }), signer);

    await expect(control.tightenStop(ID_A, "3200")).rejects.toThrow(/not tighter/);
    await expect(control.tightenStop(ID_A, "3300")).rejects.toThrow(/not tighter/);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("tightenStop refuses an order with no trigger, and a malformed price", async () => {
    const signer = signerFor();
    const order = orderFixture({ orderId: ID_A, orderType: "market", trigger: null });
    const { fetch, calls } = mockFetch(() => ({ body: { order, fills: [] } }));
    const control = createOrderControl(new FlashClient({ apiKey: KEY, fetch, clock: fakeClock() }), signer);

    await expect(control.tightenStop(ID_A, "3400")).rejects.toThrow(/no trigger/);
    await expect(control.tightenStop(ID_A, "3.4e3")).rejects.toThrow(/plain decimal/);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});
