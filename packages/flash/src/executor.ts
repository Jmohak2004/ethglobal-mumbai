// Pure orchestration: OrderIntent -> quote -> sign -> submit (live), or quote -> simulated fill (paper).
// The client is injected, so tests and other callers can substitute it. No transactions are sent here.

import type { OrderIntent, TokenInfo } from "@arena/shared";
import type { FlashClient } from "./client.ts";
import { buildOrderRequest, intentToQuoteRequest } from "./mapping.ts";
import { approvalRequirements, signFlashOrder, type ApprovalRequirements, type OrderSigner } from "./signing.ts";
import type { QuoteResponse } from "./types.ts";

export type ExecutionMode = "paper" | "live";

export interface ExecuteOptions {
  /** USD per target unit. Required for sell orders (Flash sizes sells in target units). */
  referencePriceUsd?: number;
  maxSlippage?: string;
  maxPriceImpact?: string;
  evmUsePermit2?: boolean;
  forceMinimalAllowance?: boolean;
}

export interface FlashExecutorOptions {
  client: Pick<FlashClient, "quote" | "submitOrder">;
  /** Integrator fee in bps, sent as flashIntegratorFeeBps on quote and order. */
  integratorFeeBps: number;
  tokens?: Record<string, TokenInfo>;
}

/** Thrown in live mode when the quote needs onchain setup first. The executor never sends that tx itself. */
export class FlashApprovalRequiredError extends Error {
  readonly requirements: ApprovalRequirements;
  readonly quote: QuoteResponse;

  constructor(requirements: ApprovalRequirements, quote: QuoteResponse) {
    super("Flash quote requires onchain setup (approval/wrap) before the order can be submitted");
    this.name = "FlashApprovalRequiredError";
    this.requirements = requirements;
    this.quote = quote;
  }
}

export interface LiveExecutionResult {
  paper: false;
  orderId: string;
  /** The submit call returns only orderId (and attachedBracket.status). Fill status comes from WS or GET /orders. */
  status: "submitted";
  quote: QuoteResponse;
  attachedBracketStatus: string | null;
}

export interface PaperExecutionResult {
  paper: true;
  /** Synthetic ID, prefixed "paper-", so it can never be confused with a Flash orderId. */
  orderId: string;
  status: "simulated_fill";
  quote: QuoteResponse;
  fill: { qty: number; price: number; notionalUsd: number; ts: number };
}

export type ExecutionResult = LiveExecutionResult | PaperExecutionResult;

export class FlashExecutor {
  private readonly client: FlashExecutorOptions["client"];
  private readonly integratorFeeBps: number;
  private readonly tokens: FlashExecutorOptions["tokens"];

  constructor(opts: FlashExecutorOptions) {
    this.client = opts.client;
    this.integratorFeeBps = opts.integratorFeeBps;
    this.tokens = opts.tokens;
  }

  async execute(
    intent: OrderIntent,
    signer: OrderSigner,
    mode: ExecutionMode,
    opts: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    const quoteReq = intentToQuoteRequest(intent, {
      chain: "base",
      funderAddress: signer.address,
      integratorFeeBps: this.integratorFeeBps,
      tokens: this.tokens,
      referencePriceUsd: opts.referencePriceUsd,
      maxSlippage: opts.maxSlippage,
      maxPriceImpact: opts.maxPriceImpact,
      evmUsePermit2: opts.evmUsePermit2,
      forceMinimalAllowance: opts.forceMinimalAllowance,
    });

    const quote = await this.client.quote(quoteReq);

    if (mode === "paper") return paperFill(quote);

    const reqs = approvalRequirements(quote);
    if (reqs.requiresOnchainTx) throw new FlashApprovalRequiredError(reqs, quote);
    if (!quote.evm?.orderTypedData) {
      throw new Error("quote returned no evm.orderTypedData; cannot sign");
    }

    const userSignature = await signFlashOrder(quote.evm.orderTypedData, signer);
    const evmPermitSignature = quote.evm.permitTypedData
      ? await signFlashOrder(quote.evm.permitTypedData, signer)
      : undefined;

    let attachedBracket: { userSignature: string; evmPermitSignature?: string } | undefined;
    if (quoteReq.attachedBracket) {
      const ab = quote.attachedBracket?.evm;
      if (!ab) throw new Error("quote returned no attachedBracket signing data");
      attachedBracket = {
        userSignature: await signFlashOrder(ab.orderTypedData, signer),
        evmPermitSignature: ab.permitTypedData ? await signFlashOrder(ab.permitTypedData, signer) : undefined,
      };
    }

    const submitReq = buildOrderRequest(quoteReq, quote, {
      userSignature,
      evmPermitSignature,
      attachedBracket,
    });
    const res = await this.client.submitOrder(submitReq);
    return {
      paper: false,
      orderId: res.orderId,
      status: "submitted",
      quote,
      attachedBracketStatus: res.attachedBracket?.status ?? null,
    };
  }
}

/** Simulated fill at the quoted price: the target leg's notional divided by its amount. */
function paperFill(quote: QuoteResponse): PaperExecutionResult {
  const leg = quote.from.asset === "target" ? quote.from : quote.to;
  const qty = Number(leg.amount);
  const notionalUsd = Number(leg.notional);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(notionalUsd)) {
    throw new Error("quote has no usable target leg for a paper fill");
  }
  return {
    paper: true,
    orderId: `paper-${quote.quoteId}`,
    status: "simulated_fill",
    quote,
    fill: { qty, price: notionalUsd / qty, notionalUsd, ts: Date.now() },
  };
}
