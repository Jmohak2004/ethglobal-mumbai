// Maps the platform's OrderIntent (@arena/shared) onto Flash quote/order request fields.
// Same-chain Base only: cross-chain orders are disabled by policy and are never produced here.
//
// Units (per Flash docs):
//   - buy:  qty is in contraAsset (USDC) units, so qty = notionalUsd.
//   - sell: qty is in targetAsset units, so qty = notionalUsd / referencePriceUsd (caller supplies the price).
//   - limitNotionalPrice / triggers[].notionalPrice are USD prices of targetAsset.
//   - trailPercent is a decimal fraction (0.005 to 0.5). OrderIntent.trailPercent is read as a percent (5 = 5%).

import { BASE_TOKENS, type OrderIntent, type TokenInfo } from "@arena/shared";
import type {
  AttachedBracketLeg,
  QuoteRequest,
  QuoteResponse,
  SubmitOrderRequest,
} from "./types.ts";

export class FlashMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashMappingError";
  }
}

export interface IntentMappingOptions {
  chain: "base";
  /** Wallet that funds the order (the signer). Set on quote and order. */
  funderAddress: string;
  /** Integrator fee in bps, sent as flashIntegratorFeeBps (string). Docs maximum: 1000. */
  integratorFeeBps: number;
  /** Token registry. Defaults to BASE_TOKENS from @arena/shared. Must contain USDC. */
  tokens?: Record<string, TokenInfo>;
  /** USD per targetAsset unit. Required for sell orders because Flash sizes sells in target units. */
  referencePriceUsd?: number;
  maxSlippage?: string;
  maxPriceImpact?: string;
  evmUsePermit2?: boolean;
  forceMinimalAllowance?: boolean;
}

/**
 * Plain decimal string (never exponent notation) with at most `maxDecimals` places, truncated toward zero.
 * Uses 15 significant digits first so binary float noise (0.1 * 3 style artifacts) is dropped. Truncation means
 * a sell quantity can never exceed the amount the caller intended.
 */
export function decimalString(x: number, maxDecimals: number): string {
  if (!Number.isFinite(x)) throw new FlashMappingError(`non-finite number: ${x}`);
  const neg = x < 0;
  const [mant = "0", expStr = "0"] = Math.abs(x).toExponential(14).split("e");
  const exp = Number(expStr);
  const digits = mant.replace(".", "");
  let intPart: string;
  let frac: string;
  if (exp >= 0) {
    intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    frac = digits.slice(exp + 1);
  } else {
    intPart = "0";
    frac = "0".repeat(-exp - 1) + digits;
  }
  frac = frac.slice(0, Math.min(maxDecimals, 20)).replace(/0+$/, "");
  const out = frac ? `${intPart}.${frac}` : intPart;
  return neg && out !== "0" ? `-${out}` : out;
}

function positive(name: string, x: number | undefined): number {
  if (x === undefined || !Number.isFinite(x) || x <= 0) {
    throw new FlashMappingError(`${name} must be a positive finite number, got ${x}`);
  }
  return x;
}

function requireAbsent(name: string, x: unknown, orderType: string): void {
  if (x !== undefined) throw new FlashMappingError(`${name} is not valid for orderType "${orderType}"`);
}

/** Maps OrderIntent to a Flash QuoteRequest. The same object is reused (with signatures) for submission. */
export function intentToQuoteRequest(intent: OrderIntent, opts: IntentMappingOptions): QuoteRequest {
  if (opts.chain !== "base") throw new FlashMappingError("only chain 'base' is supported");
  if (!opts.funderAddress) throw new FlashMappingError("funderAddress is required");
  if (intent.quoteAsset !== "USDC") throw new FlashMappingError(`quoteAsset must be USDC, got ${intent.quoteAsset}`);

  const tokens = opts.tokens ?? BASE_TOKENS;
  const usdc = tokens.USDC;
  if (!usdc) throw new FlashMappingError("token registry has no USDC");
  if (intent.asset === "USDC") throw new FlashMappingError("asset cannot be USDC");
  const target = tokens[intent.asset];
  if (!target) throw new FlashMappingError(`asset ${intent.asset} is not in the token registry`);

  const notional = positive("notionalUsd", intent.notionalUsd);
  const feeBps = opts.integratorFeeBps;
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 1000) {
    throw new FlashMappingError("integratorFeeBps must be between 0 and 1000");
  }

  let qty: string;
  if (intent.side === "buy") {
    qty = decimalString(notional, usdc.decimals);
  } else {
    const price = positive("referencePriceUsd (required for sell)", opts.referencePriceUsd);
    qty = decimalString(notional / price, target.decimals);
  }
  if (Number(qty) <= 0) throw new FlashMappingError("order quantity rounds to zero");

  const req: QuoteRequest = {
    targetChain: "base",
    contraChain: "base",
    targetAsset: target.address,
    contraAsset: usdc.address,
    side: intent.side,
    qty,
    orderType: intent.orderType,
    funderAddress: opts.funderAddress,
    flashIntegratorFeeBps: String(feeBps),
  };
  if (opts.maxSlippage !== undefined) req.maxSlippage = opts.maxSlippage;
  if (opts.maxPriceImpact !== undefined) req.maxPriceImpact = opts.maxPriceImpact;
  if (opts.evmUsePermit2 !== undefined) req.evmUsePermit2 = opts.evmUsePermit2;
  if (opts.forceMinimalAllowance !== undefined) req.forceMinimalAllowance = opts.forceMinimalAllowance;

  applyOrderType(req, intent);
  applyAttachedBracket(req, intent);
  return req;
}

function applyOrderType(req: QuoteRequest, intent: OrderIntent): void {
  const { orderType, side } = intent;
  const limit = intent.limitPrice;
  const trigger = intent.triggerPrice;
  const requireSide = (expected: "buy" | "sell") => {
    if (side !== expected) throw new FlashMappingError(`orderType "${orderType}" requires side ${expected}`);
  };

  switch (orderType) {
    case "market":
      requireAbsent("limitPrice", limit, orderType);
      requireAbsent("triggerPrice", trigger, orderType);
      requireAbsent("twap", intent.twap, orderType);
      return;

    case "limit": {
      // Flash v1 rejects limitNotionalPrice on a limit entry that carries an attachedBracket and requires
      // limitCrossPrice (contra units per target unit). Our contra asset is always USDC, so the cross price is the
      // same number as the USD limit price.
      const price = decimalString(positive("limitPrice", limit), 8);
      if (intent.attachedBracket) req.limitCrossPrice = price;
      else req.limitNotionalPrice = price;
      requireAbsent("triggerPrice", trigger, orderType);
      return;
    }

    case "twap": {
      if (!intent.twap) throw new FlashMappingError("twap orderType requires intent.twap");
      const { durationSeconds, bucketCount } = intent.twap;
      // Flash enforces durationSeconds >= 300 (PRD 7.1 says 10 min; the API minimum is the binding limit).
      if (!Number.isInteger(durationSeconds) || durationSeconds < 300) {
        throw new FlashMappingError("twap.durationSeconds must be an integer >= 300");
      }
      if (!Number.isInteger(bucketCount) || bucketCount < 2 || bucketCount > 2560) {
        throw new FlashMappingError("twap.bucketCount must be an integer between 2 and 2560");
      }
      req.durationSeconds = durationSeconds;
      req.twapBucketCount = bucketCount;
      if (limit !== undefined) req.limitNotionalPrice = decimalString(positive("limitPrice", limit), 8);
      requireAbsent("triggerPrice", trigger, orderType);
      return;
    }

    case "stop":
      // Flash "stop" is a market buy that fires when the price rises to the trigger.
      requireSide("buy");
      req.triggers = [{ notionalPrice: decimalString(positive("triggerPrice", trigger), 8), triggerType: "upper" }];
      if (limit !== undefined) req.limitNotionalPrice = decimalString(positive("limitPrice", limit), 8);
      return;

    case "stop-loss":
      requireSide("sell");
      req.triggers = [{ notionalPrice: decimalString(positive("triggerPrice", trigger), 8), triggerType: "lower" }];
      if (limit !== undefined) req.limitNotionalPrice = decimalString(positive("limitPrice", limit), 8);
      return;

    case "take-profit":
      requireSide("sell");
      req.triggers = [{ notionalPrice: decimalString(positive("triggerPrice", trigger), 8), triggerType: "upper" }];
      if (limit !== undefined) req.limitNotionalPrice = decimalString(positive("limitPrice", limit), 8);
      return;

    case "bracket": {
      // Standalone bracket: sell side, fixed qty, two triggers with opposite triggerType.
      // The OrderIntent.attachedBracket prices are reused as the two legs here (take-profit upper, stop-loss lower).
      requireSide("sell");
      const b = intent.attachedBracket;
      if (!b) throw new FlashMappingError("bracket orderType requires attachedBracket prices");
      const tp = positive("takeProfitPrice", b.takeProfitPrice);
      const sl = positive("stopLossPrice", b.stopLossPrice);
      if (tp <= sl) throw new FlashMappingError("takeProfitPrice must be above stopLossPrice");
      req.triggers = [
        { notionalPrice: decimalString(tp, 8), triggerType: "upper" },
        { notionalPrice: decimalString(sl, 8), triggerType: "lower" },
      ];
      requireAbsent("limitPrice", limit, orderType);
      return;
    }

    case "trailing-stop":
    case "trailing-stop-limit": {
      // Sell side only. The docs describe trailing-stop as market-on-trigger; the limit semantics of
      // trailing-stop-limit are not specified, so a limit price is rejected rather than guessed.
      requireSide("sell");
      const pct = intent.trailPercent;
      if (pct === undefined || !Number.isFinite(pct)) throw new FlashMappingError("trailPercent is required");
      const fraction = pct / 100;
      if (fraction < 0.005 || fraction > 0.5) {
        throw new FlashMappingError("trailPercent must be between 0.5 and 50 (percent)");
      }
      req.trailingStop = { trailPercent: decimalString(fraction, 6) };
      if (trigger !== undefined) {
        req.trailingStop.activationPrice = decimalString(positive("triggerPrice", trigger), 8);
      }
      requireAbsent("limitPrice", limit, orderType);
      return;
    }

    default: {
      const never: never = orderType;
      throw new FlashMappingError(`unsupported orderType ${String(never)}`);
    }
  }
}

/**
 * Attached TP/SL on an entry. Flash docs: entries of type market, limit or TWAP only; legs protect the
 * received asset, so the entry must be a buy. Legs are notionalPrice (USD) triggers on targetAsset.
 */
function applyAttachedBracket(req: QuoteRequest, intent: OrderIntent): void {
  if (!intent.attachedBracket) return;
  if (req.orderType === "bracket") return; // already consumed as standalone triggers
  if (!["market", "limit", "twap"].includes(intent.orderType)) {
    throw new FlashMappingError(`attachedBracket is only valid on market, limit or twap entries (got ${intent.orderType})`);
  }
  if (intent.side !== "buy") throw new FlashMappingError("attachedBracket requires a buy entry");
  const tp = positive("takeProfitPrice", intent.attachedBracket.takeProfitPrice);
  const sl = positive("stopLossPrice", intent.attachedBracket.stopLossPrice);
  if (tp <= sl) throw new FlashMappingError("takeProfitPrice must be above stopLossPrice");
  const takeProfit: AttachedBracketLeg = { notionalPrice: decimalString(tp, 8) };
  const stopLoss: AttachedBracketLeg = { notionalPrice: decimalString(sl, 8) };
  req.attachedBracket = { takeProfit, stopLoss };
}

// ---------------------------------------------------------------------------
// Submit request
// ---------------------------------------------------------------------------

export interface OrderSignatures {
  /** EIP-712 signature over quote.evm.orderTypedData. */
  userSignature: string;
  /** EIP-712 signature over quote.evm.permitTypedData. Required only when the quote returned one. */
  evmPermitSignature?: string;
  /** Signatures for the attached bracket, required only when the request has attachedBracket. */
  attachedBracket?: {
    /** EIP-712 signature over quote.attachedBracket.evm.orderTypedData. */
    userSignature: string;
    /** EIP-712 signature over quote.attachedBracket.evm.permitTypedData, when present. */
    evmPermitSignature?: string;
  };
}

/**
 * Builds POST /order from the quote request, quote response and signatures. Echoes the quote's typed data
 * unchanged (evmOrderTypedData, evmPermitTypedData, attachedBracket.evmPermitTypedData) as the docs require.
 * Quote-only fields (expireTime, durationSeconds, evmUsePermit2, forceMinimalAllowance, svmUseNativeSOL)
 * are dropped because SubmitOrderRequest does not accept them.
 */
export function buildOrderRequest(
  req: QuoteRequest,
  quote: QuoteResponse,
  sigs: OrderSignatures,
): SubmitOrderRequest {
  if (!req.funderAddress) throw new FlashMappingError("quote request has no funderAddress");
  if (quote.bridgeQuoteId) throw new FlashMappingError("cross-chain quotes are not supported");
  const evm = quote.evm;
  if (!evm || !evm.orderTypedData) {
    throw new FlashMappingError("quote has no evm.orderTypedData (EVM funder required, or funderAddress was omitted)");
  }

  const {
    expireTime: _expireTime,
    durationSeconds: _durationSeconds,
    evmUsePermit2: _usePermit2,
    forceMinimalAllowance: _minimal,
    svmUseNativeSOL: _svmNative,
    attachedBracket: quoteBracket,
    ...shared
  } = req;

  const out: SubmitOrderRequest = {
    ...shared,
    funderAddress: req.funderAddress,
    quoteId: quote.quoteId,
    userSignature: sigs.userSignature,
    evmOrderTypedData: evm.orderTypedData,
  };

  if (evm.permitTypedData) {
    if (!sigs.evmPermitSignature) throw new FlashMappingError("quote requires a Permit2 signature (evm.permitTypedData)");
    out.evmPermitTypedData = evm.permitTypedData;
    out.evmPermitSignature = sigs.evmPermitSignature;
  }

  if (quoteBracket) {
    const ab = quote.attachedBracket;
    if (!ab || !ab.evm) throw new FlashMappingError("quote is missing attachedBracket signing data");
    if (!sigs.attachedBracket) throw new FlashMappingError("attachedBracket signatures are required");
    const bracket: NonNullable<SubmitOrderRequest["attachedBracket"]> = {
      takeProfit: quoteBracket.takeProfit,
      stopLoss: quoteBracket.stopLoss,
      userSignature: sigs.attachedBracket.userSignature,
      deadline: ab.deadline,
      signedMaxFromAmount: ab.signedMaxFromAmount,
    };
    if (ab.salt) bracket.salt = ab.salt;
    if (ab.evm.permitTypedData) {
      if (!sigs.attachedBracket.evmPermitSignature) {
        throw new FlashMappingError("attachedBracket requires a Permit2 signature");
      }
      bracket.evmPermitTypedData = ab.evm.permitTypedData;
      bracket.evmPermitSignature = sigs.attachedBracket.evmPermitSignature;
    }
    out.attachedBracket = bracket;
  }

  return out;
}
