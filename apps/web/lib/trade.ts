// Manual trading flow for the terminal: quote -> onchain setup -> sign -> submit. Client-only.
// The wallet operations are injected, so this module has no wagmi dependency.
import { parseTransaction, type Hex } from "viem";

import { postJson } from "@/lib/api";
import { toSignable, type SignableTypedData } from "@/lib/typed-data";
import type { CancelPlan, CancelResult, OrderSignatures, TicketInput, TradeQuote } from "@/lib/types";

export type LiveQuote = Extract<TradeQuote, { mode: "live" }>;

export interface WalletOps {
  sendTransaction(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<`0x${string}`>;
  waitForTransaction(hash: `0x${string}`): Promise<void>;
  signTypedData(td: SignableTypedData): Promise<`0x${string}`>;
}

export function fetchQuote(ticket: TicketInput, markPriceUsd: number): Promise<TradeQuote> {
  return postJson<TradeQuote>("/api/flash/quote", { ticket, markPriceUsd });
}

/** Runs the onchain steps in order, signs the order (and bracket) payloads, then submits. Returns the Flash order id. */
export async function executeLiveTrade(
  q: LiveQuote,
  wallet: WalletOps,
  onStep: (label: string) => void,
): Promise<{ orderId: string; bracketStatus: string | null }> {
  for (const step of q.steps) {
    const tx =
      step.kind === "setup"
        ? setupTx(step.raw)
        : { to: step.to, data: step.data, value: BigInt(step.value || "0") };
    onStep(step.kind === "setup" ? "Sending Flash setup transaction" : `Sending ${step.kind.replace("-", " ")}`);
    const hash = await wallet.sendTransaction(tx);
    onStep("Waiting for confirmation");
    await wallet.waitForTransaction(hash);
  }

  const permit = q.sign.permit ? await wallet.signTypedData(toSignable(q.sign.permit)) : undefined;
  onStep("Sign the order in your wallet");
  const order = await wallet.signTypedData(toSignable(q.sign.order));

  const signatures: OrderSignatures = { order };
  if (permit) signatures.permit = permit;
  if (q.sign.bracket) {
    signatures.bracketOrder = await wallet.signTypedData(toSignable(q.sign.bracket.order));
    if (q.sign.bracket.permit) signatures.bracketPermit = await wallet.signTypedData(toSignable(q.sign.bracket.permit));
  }

  onStep("Submitting order");
  return postJson<{ orderId: string; bracketStatus: string | null }>("/api/flash/order", {
    quoteId: q.quoteId,
    signatures,
  });
}

/** Flash accepts at most 25 order ids per batch cancel. */
export const FLASH_CANCEL_BATCH = 25;

/**
 * Cancels Flash orders with the funder wallet. One signature per batch of up to 25 ids, in the order given.
 * Returns null in paper mode: nothing was sent, and the caller marks the rows locally.
 */
export async function cancelFlashOrders(
  orderIds: string[],
  signMessage: (message: string) => Promise<`0x${string}`>,
): Promise<CancelResult[] | null> {
  const results: CancelResult[] = [];
  for (let i = 0; i < orderIds.length; i += FLASH_CANCEL_BATCH) {
    const plan = await postJson<CancelPlan>("/api/flash/cancel", { orderIds: orderIds.slice(i, i + FLASH_CANCEL_BATCH) });
    if (plan.mode === "paper") return null;
    const signature = await signMessage(plan.message);
    const res = await postJson<{ results: CancelResult[] }>("/api/flash/cancel/submit", {
      orderIds: plan.orderIds,
      message: plan.message,
      signature,
    });
    results.push(...res.results);
  }
  return results;
}

/** A Flash setup entry is a serialized transaction. Decode it so the wallet can send it like any other call. */
function setupTx(raw: string): { to: `0x${string}`; data: `0x${string}`; value: bigint } {
  const parsed = parseTransaction(raw as Hex);
  if (!parsed.to) throw new Error("Flash setup transaction has no recipient");
  return { to: parsed.to, data: (parsed.data ?? "0x") as `0x${string}`, value: parsed.value ?? 0n };
}
