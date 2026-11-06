// Signed messages for Flash cancel and update requests. Byte-exact per the Flash OpenAPI spec:
//   POST /orders/{orderId}/cancel   cancelMessage
//   POST /orders/cancel             cancelMessage (batch)
//   PATCH /orders/{orderId}         updateMessage
// The builders are pure string functions. The *Signed helpers sign with a MessageSigner (EIP-191 personal_sign)
// and call the FlashClient they are given. Nothing here talks to Flash on its own.
// The em dash is U+2014, written as an escape so it cannot be replaced by a hyphen. Lines are joined with "\n"
// and never end with a newline.

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { FlashClient } from "./client.ts";
import { ORDER_ID_PATTERN, type BatchCancelOrderResponse, type TriggerType } from "./types.ts";

const EM_DASH = "—";
const CANCEL_TITLE = `Definitive Flash v1 ${EM_DASH} Cancel Order`;
const CANCEL_BATCH_TITLE = `Definitive Flash v1 ${EM_DASH} Cancel Orders`;
const UPDATE_TITLE = `Definitive Flash ${EM_DASH} Update Order`;

const MAX_BATCH_CANCEL = 25;
/** Plain unsigned decimal. No sign, exponent, leading dot or whitespace: Flash compares the exact string. */
const DECIMAL = /^\d+(\.\d+)?$/;

export type PriceBasis = "cross" | "notional";

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

/** Any funder wallet that can sign a plain message: a local key, a wagmi/Privy adapter, or a test double. */
export interface MessageSigner {
  readonly address: `0x${string}`;
  /** EIP-191 personal_sign over the UTF-8 bytes of `message`. Returns a 65-byte 0x-prefixed signature. */
  signMessage(message: string): Promise<`0x${string}`>;
}

/** MessageSigner backed by a raw private key (tests, scripts, server-held keys). */
export function localMessageSigner(privateKey: Hex): MessageSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
  };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

function assertOrderId(orderId: string): void {
  if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId)) {
    throw new RangeError(`order id must be a lowercase hyphenated UUID, got ${JSON.stringify(orderId)}`);
  }
}

/** "Definitive Flash v1 — Cancel Order\nOrder: <orderId>" */
export function buildCancelMessage(orderId: string): string {
  assertOrderId(orderId);
  return `${CANCEL_TITLE}\nOrder: ${orderId}`;
}

/** "Definitive Flash v1 — Cancel Orders\nOrders:\n<id>\n<id>..." One to 25 unique lowercase ids, in request order. */
export function buildBatchCancelMessage(orderIds: readonly string[]): string {
  if (orderIds.length < 1 || orderIds.length > MAX_BATCH_CANCEL) {
    throw new RangeError(`batch cancel takes 1 to ${MAX_BATCH_CANCEL} order ids, got ${orderIds.length}`);
  }
  const seen = new Set<string>();
  for (const id of orderIds) {
    assertOrderId(id);
    if (seen.has(id)) throw new RangeError(`duplicate order id ${id}: Flash rejects duplicates`);
    seen.add(id);
  }
  return [CANCEL_BATCH_TITLE, "Orders:", ...orderIds].join("\n");
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** One price, in exactly one basis. */
type PriceFields = { crossPrice: string; notionalPrice?: undefined } | { notionalPrice: string; crossPrice?: undefined };

/** New trigger for a stop, stop-limit or take-profit order. The direction and basis must match the placed trigger. */
export type TriggerInput = { triggerType: TriggerType } & PriceFields;

/** A bracket leg. limitPrice is optional: omitted means the leg sells at market when it fires. */
export type BracketLegInput = TriggerInput & { limitPrice?: string };

export interface UpdateOrderInput {
  orderId: string;
  /** Stamped into the message as RFC3339 UTC with milliseconds. Flash rejects stamps outside a small skew window. */
  issuedAt: Date;
  /** New limit (post-trigger execution limit), in pair-rate units. Set at most one limit field. */
  limitCrossPrice?: string;
  /** New limit in USD for the traded asset. Set at most one limit field. */
  limitNotionalPrice?: string;
  trigger?: TriggerInput;
  /** New legs for a bracket order: exactly one lower and one upper. Not combinable with any other field. */
  triggers?: readonly [BracketLegInput, BracketLegInput];
}

/**
 * Request shape of a trigger. Every price is the identical string that was signed. Type aliases, not interfaces:
 * the request type from zod has an index signature, which only aliases satisfy.
 */
export type TriggerFields = {
  triggerType: TriggerType;
  crossPrice?: string;
  notionalPrice?: string;
};

export type BracketLegFields = TriggerFields & { limitPrice?: string };

/** Request fields that accompany updateMessage. Every price is the identical string that was signed. */
export interface UpdateOrderFields {
  limitCrossPrice?: string;
  limitNotionalPrice?: string;
  trigger?: TriggerFields;
  triggers?: [BracketLegFields, BracketLegFields];
}

export interface BuiltUpdate {
  /** Exact text to sign. Echo it back as updateMessage. */
  message: string;
  fields: UpdateOrderFields;
}

/**
 * Builds the update message and the matching request fields.
 *
 * Message layout, in order:
 *   "Definitive Flash — Update Order", "Order: <id>", "Issued At: <RFC3339 UTC>",
 *   then either "Limit Cross|Notional Price: <p>" and/or "Trigger Lower|Upper Cross|Notional Price: <p>"
 *   (limit first), or for a bracket: per leg, the lower leg first, "Trigger <Dir> <Basis> Price: <p>" and
 *   "Trigger <Dir> Limit Price: <p>" when the leg has a limitPrice.
 *
 * Prices are validated as plain positive decimal strings and are never reformatted. A bracket's legs are
 * sent in the same lower-first order as they are signed.
 */
export function buildUpdateMessage(input: UpdateOrderInput): BuiltUpdate {
  assertOrderId(input.orderId);
  const head = [UPDATE_TITLE, `Order: ${input.orderId}`, `Issued At: ${formatIssuedAt(input.issuedAt)}`];

  if (input.limitCrossPrice !== undefined && input.limitNotionalPrice !== undefined) {
    throw new RangeError("set limitCrossPrice or limitNotionalPrice, not both");
  }
  const hasLimit = input.limitCrossPrice !== undefined || input.limitNotionalPrice !== undefined;

  if (input.triggers !== undefined) {
    if (hasLimit || input.trigger !== undefined) {
      throw new RangeError("a bracket update takes only triggers: no limit or trigger fields");
    }
    const [lower, upper] = orderBracketLegs(input.triggers);
    const lines = [...head];
    const lowerFields = bracketLeg(lower, lines);
    const upperFields = bracketLeg(upper, lines);
    return { message: lines.join("\n"), fields: { triggers: [lowerFields, upperFields] } };
  }

  if (!hasLimit && input.trigger === undefined) {
    throw new RangeError("an update needs a limit price, a trigger, or bracket triggers");
  }

  const lines = [...head];
  const fields: UpdateOrderFields = {};

  if (input.limitCrossPrice !== undefined) {
    const v = decimal(input.limitCrossPrice, "limitCrossPrice");
    lines.push(`Limit Cross Price: ${v}`);
    fields.limitCrossPrice = v;
  } else if (input.limitNotionalPrice !== undefined) {
    const v = decimal(input.limitNotionalPrice, "limitNotionalPrice");
    lines.push(`Limit Notional Price: ${v}`);
    fields.limitNotionalPrice = v;
  }

  if (input.trigger !== undefined) {
    const triggerType = directionOf(input.trigger.triggerType, "trigger");
    const { basis, price } = triggerPrice(input.trigger, "trigger");
    lines.push(`Trigger ${directionLabel(triggerType)} ${basisLabel(basis)} Price: ${price}`);
    fields.trigger = { triggerType, ...priceField(basis, price) };
  }

  return { message: lines.join("\n"), fields };
}

// ---------------------------------------------------------------------------
// Signed request helpers
// ---------------------------------------------------------------------------

/** Signs the cancel message and calls POST /orders/{orderId}/cancel. */
export async function cancelOrderSigned(client: FlashClient, orderId: string, signer: MessageSigner): Promise<{ ok: true }> {
  const cancelMessage = buildCancelMessage(orderId);
  const userSignature = await signer.signMessage(cancelMessage);
  return client.cancelOrder(orderId, { cancelMessage, userSignature });
}

/** Signs the batch cancel message once and calls POST /orders/cancel. */
export async function batchCancelSigned(
  client: FlashClient,
  orderIds: readonly string[],
  signer: MessageSigner,
): Promise<BatchCancelOrderResponse> {
  const ids = [...orderIds];
  const cancelMessage = buildBatchCancelMessage(ids);
  const userSignature = await signer.signMessage(cancelMessage);
  return client.batchCancel({ orderIds: ids, cancelMessage, userSignature });
}

/**
 * Builds, signs and sends PATCH /orders/{orderId}. `issuedAt` defaults to now. The request carries the same
 * updateMessage bytes that were signed, plus the exact price strings from the message.
 */
export async function updateOrderSigned(
  client: FlashClient,
  args: Omit<UpdateOrderInput, "issuedAt"> & { issuedAt?: Date },
  signer: MessageSigner,
): Promise<{ ok: true }> {
  const { message, fields } = buildUpdateMessage({ ...args, issuedAt: args.issuedAt ?? new Date() });
  const userSignature = await signer.signMessage(message);
  return client.patchOrder(args.orderId, { updateMessage: message, userSignature, ...fields });
}

// ---------------------------------------------------------------------------
// OrderControl: the surface the worker will use
// ---------------------------------------------------------------------------

export interface OrderControl {
  /** Cancels one order with its own signature. Idempotent on the Flash side. */
  cancel(orderId: string): Promise<{ ok: true }>;
  /** Cancels 1 to 25 orders with one signature. Partial failures come back per order. */
  cancelMany(orderIds: readonly string[]): Promise<BatchCancelOrderResponse>;
  /**
   * Moves a single stop trigger closer to the market (raises a lower trigger, lowers an upper one). The direction
   * and price basis stay as placed. A looser value is rejected before anything is signed.
   */
  tightenStop(orderId: string, newStopPrice: string): Promise<{ ok: true }>;
}

/** OrderControl for one funder. The funder is the signer's address. */
export function createOrderControl(client: FlashClient, signer: MessageSigner): OrderControl {
  return {
    cancel: (orderId) => cancelOrderSigned(client, orderId, signer),
    cancelMany: (orderIds) => batchCancelSigned(client, orderIds, signer),
    tightenStop: async (orderId, newStopPrice) => {
      const next = decimal(newStopPrice, "newStopPrice");
      const { order } = await client.getOrder(orderId, signer.address);
      const trigger = order.trigger;
      if (!trigger) throw new RangeError(`order ${orderId} has no trigger to tighten`);

      const basis: PriceBasis = trigger.crossPrice !== undefined ? "cross" : "notional";
      const current = Number(basis === "cross" ? trigger.crossPrice : trigger.notionalPrice);
      const target = Number(next);
      const tighter = trigger.triggerType === "lower" ? target > current : target < current;
      if (!tighter) {
        throw new RangeError(`newStopPrice ${next} is not tighter than the current ${trigger.triggerType} trigger ${current}`);
      }
      return updateOrderSigned(
        client,
        { orderId, trigger: { triggerType: trigger.triggerType, ...priceField(basis, next) } },
        signer,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function formatIssuedAt(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RangeError("issuedAt must be a valid Date");
  return d.toISOString();
}

/** Positive plain decimal string, returned unchanged. */
function decimal(value: string, what: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || Number(value) <= 0) {
    throw new RangeError(`${what} must be a positive plain decimal string such as "3500" or "3500.25", got ${JSON.stringify(value)}`);
  }
  return value;
}

function directionOf(value: unknown, what: string): TriggerType {
  if (value === "lower" || value === "upper") return value;
  throw new RangeError(`${what}.triggerType must be "lower" or "upper", got ${JSON.stringify(value)}`);
}

/** Appends a bracket leg's Trigger (and optional Limit) lines to `lines` and returns its request fields. */
function bracketLeg(leg: BracketLegInput, lines: string[]): BracketLegFields {
  const dir = directionLabel(leg.triggerType);
  const { basis, price } = triggerPrice(leg, `${leg.triggerType} leg`);
  lines.push(`Trigger ${dir} ${basisLabel(basis)} Price: ${price}`);
  if (leg.limitPrice === undefined) return { triggerType: leg.triggerType, ...priceField(basis, price) };
  const limit = decimal(leg.limitPrice, `${leg.triggerType} leg limitPrice`);
  lines.push(`Trigger ${dir} Limit Price: ${limit}`);
  return { triggerType: leg.triggerType, ...priceField(basis, price), limitPrice: limit };
}

function triggerPrice(
  t: { crossPrice?: string | undefined; notionalPrice?: string | undefined },
  what: string,
): { basis: PriceBasis; price: string } {
  const { crossPrice, notionalPrice } = t;
  if (crossPrice !== undefined && notionalPrice === undefined) {
    return { basis: "cross", price: decimal(crossPrice, `${what} crossPrice`) };
  }
  if (notionalPrice !== undefined && crossPrice === undefined) {
    return { basis: "notional", price: decimal(notionalPrice, `${what} notionalPrice`) };
  }
  throw new RangeError(`${what}: set exactly one of crossPrice or notionalPrice`);
}

function priceField(basis: PriceBasis, price: string): { crossPrice: string } | { notionalPrice: string } {
  return basis === "cross" ? { crossPrice: price } : { notionalPrice: price };
}

function orderBracketLegs(legs: readonly [BracketLegInput, BracketLegInput]): [BracketLegInput, BracketLegInput] {
  if (!Array.isArray(legs) || legs.length !== 2) throw new RangeError("a bracket update takes exactly two legs");
  const [a, b] = legs;
  const dirs = [directionOf(a.triggerType, "triggers[0]"), directionOf(b.triggerType, "triggers[1]")];
  if (dirs[0] === dirs[1]) throw new RangeError("a bracket update needs one lower leg and one upper leg");
  return dirs[0] === "lower" ? [a, b] : [b, a];
}

function directionLabel(t: TriggerType): "Lower" | "Upper" {
  return t === "lower" ? "Lower" : "Upper";
}

function basisLabel(b: PriceBasis): "Cross" | "Notional" {
  return b === "cross" ? "Cross" : "Notional";
}
