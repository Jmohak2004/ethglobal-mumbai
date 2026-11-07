"use client";

import { clsx } from "clsx";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, useChainId, useSendTransaction, useSignTypedData, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/api";
import { fmtAmount, fmtUsd } from "@/lib/format";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";
import { PAPER_FILLS_QUERY_KEY, addPaperFill, savePaperFill } from "@/lib/paper-fills";
import { CHAIN } from "@/lib/contracts";
import { executeLiveTrade, fetchQuote, type LiveQuote, type WalletOps } from "@/lib/trade";
import { DEMO_CAPS, FLASH_INTEGRATOR_FEE_BPS } from "@/lib/templates";
import type { TicketInput, TradeQuote } from "@/lib/types";
import { wagmiConfig } from "@/lib/wagmi";

type TicketType = "market" | "limit" | "twap" | "stop" | "trailing" | "bracket";

const TYPES: TabItem<TicketType>[] = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
  { value: "twap", label: "TWAP" },
  { value: "stop", label: "Stop" },
  { value: "trailing", label: "Trailing" },
  { value: "bracket", label: "Bracket" },
];

export interface TicketPrefill {
  limitPx?: number;
  tpPx?: number;
  slPx?: number;
}

/**
 * Order ticket for Flash order types. Flow: quote (server adds the API key and fee) -> show the quote ->
 * onchain setup steps and signatures from the wallet -> submit. Paper mode stops after the quote and records a
 * simulated fill. Nothing is sent to Flash unless the server is live.
 */
export function OrderTicket({
  asset,
  markPrice,
  prefill,
}: {
  asset: string;
  markPrice: number;
  prefill: TicketPrefill | null;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const platform = usePlatform();
  const session = useSession({ prompt: false });
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();

  const [type, setType] = useState<TicketType>("limit");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState(1);
  const [limitPx, setLimitPx] = useState(prefill?.limitPx ?? round(markPrice * 0.998));
  const [triggerPx, setTriggerPx] = useState(round(markPrice * 1.003));
  const [trailPct, setTrailPct] = useState(1.5);
  const [twapMin, setTwapMin] = useState(60);
  const [twapBuckets, setTwapBuckets] = useState(6);
  const [tpOn, setTpOn] = useState(prefill?.tpPx !== undefined);
  const [slOn, setSlOn] = useState(prefill?.slPx !== undefined);
  const [tpPx, setTpPx] = useState(prefill?.tpPx ?? round(markPrice * 1.03));
  const [slPx, setSlPx] = useState(prefill?.slPx ?? round(markPrice * 0.98));
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const maxTrade = platform.data?.caps.maxTradeUsd ?? DEMO_CAPS.maxTradeUsd;
  const sizeOk = Number.isFinite(size) && size >= 0.01 && size <= maxTrade;
  const refPx = type === "stop" ? triggerPx : type === "market" ? markPrice : limitPx;
  const notionalFee = (Number.isFinite(size) ? size : 0) * (FLASH_INTEGRATOR_FEE_BPS / 10_000);
  const isBuy = side === "buy";
  const live = platform.data?.flashLive === true;

  const ticket: TicketInput = {
    side,
    asset,
    orderType: type,
    sizeUsd: size,
    ...(type === "limit" || (type === "bracket" && isBuy) ? { limitPrice: limitPx } : {}),
    ...(type === "stop" ? { triggerPrice: triggerPx } : {}),
    ...(type === "trailing" ? { trailPct } : {}),
    ...(type === "twap" ? { twap: { durationMin: twapMin, buckets: twapBuckets } } : {}),
    ...(tpOn ? { takeProfitPrice: tpPx } : {}),
    ...(slOn ? { stopLossPrice: slPx } : {}),
  };

  const walletOps: WalletOps = {
    sendTransaction: (tx) => sendTransactionAsync({ ...tx, chainId: CHAIN.id }),
    waitForTransaction: async (hash) => {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
      if (receipt.status !== "success") throw new Error("Setup transaction reverted");
    },
    signTypedData: (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]),
  };

  const getQuote = async () => {
    if (!address) {
      openConnectModal?.();
      return;
    }
    if (!session.signedIn) {
      try {
        setBusy("Sign in with your wallet");
        await session.signIn();
      } catch (err) {
        toast({ title: "Sign-in needed to trade", description: describeError(err), tone: "error" });
        return;
      } finally {
        setBusy(null);
      }
    }
    setBusy("Getting quote");
    try {
      setQuote(await fetchQuote(ticket, markPrice));
    } catch (err) {
      toast({ title: "Quote failed", description: describeError(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (q: TradeQuote) => {
    if (q.mode === "paper") {
      setBusy("Recording simulated fill");
      try {
        await savePaperFill({
          side,
          asset,
          orderType: type,
          notionalUsd: q.notionalUsd,
          priceUsd: q.priceUsd,
          feeUsd: q.feeUsd,
          ...(q.quoteId ? { quoteId: q.quoteId } : {}),
        });
        await qc.invalidateQueries({ queryKey: PAPER_FILLS_QUERY_KEY });
        toast({
          title: "Simulated fill saved",
          description: `Recorded to your account. Not sent to Flash. Mark ${fmtAmount(q.priceUsd, 2)}.`,
          tone: "success",
        });
      } catch (err) {
        // No session or no database: keep the fill in this page session so the user still sees it.
        addPaperFill({ ts: Date.now(), asset, side, sizeUsd: q.notionalUsd, priceUsd: q.priceUsd, feeUsd: q.feeUsd, txHash: null });
        toast({
          title: "Simulated fill kept in this browser",
          description: `Not saved to your account: ${describeError(err)}. Not sent to Flash.`,
          tone: "error",
        });
      } finally {
        setBusy(null);
      }
      setQuote(null);
      return;
    }
    try {
      if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id });
      const res = await executeLiveTrade(q as LiveQuote, walletOps, setBusy);
      toast({ title: "Order placed", description: `Flash order ${res.orderId}`, tone: "success" });
      setQuote(null);
    } catch (err) {
      toast({ title: "Order not sent", description: describeError(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const mainLabel = !address
    ? "Connect wallet"
    : !session.signedIn
      ? "Sign in to trade"
      : busy ?? "Get quote";

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-panel" aria-label="Order ticket">
      <header className="flex h-8 items-center justify-between border-b border-border px-3 text-[10.5px] font-medium uppercase tracking-wider text-muted">
        <span>Order ticket</span>
        {platform.data ? (
          <span className={clsx("normal-case tracking-normal", live ? "text-long" : "text-warn")}>
            {live ? "Live · Flash" : "Paper · simulated"}
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-3 p-3">
        <Tabs value={type} items={TYPES} onChange={setType} className="overflow-x-auto" />

        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg p-0.5">
          <button
            type="button"
            aria-pressed={isBuy}
            onClick={() => {
              setSide("buy");
              setQuote(null);
            }}
            className={clsx(
              "h-7 rounded text-[12px] font-semibold transition-colors",
              isBuy ? "bg-long text-bg" : "text-muted hover:text-text",
            )}
          >
            Buy
          </button>
          <button
            type="button"
            aria-pressed={!isBuy}
            onClick={() => {
              setSide("sell");
              setQuote(null);
            }}
            className={clsx(
              "h-7 rounded text-[12px] font-semibold transition-colors",
              !isBuy ? "bg-short text-bg" : "text-muted hover:text-text",
            )}
          >
            Sell
          </button>
        </div>

        <Field
          label="Size (USD)"
          hint={sizeOk ? `Max per trade ${fmtUsd(maxTrade, 2)} (platform cap)` : `Enter 0.01 to ${maxTrade} (platform cap)`}
        >
          <Input
            type="number"
            aria-label="Size in USD"
            min={0.01}
            max={maxTrade}
            step={0.01}
            value={Number.isFinite(size) ? size : ""}
            className={clsx(!sizeOk && "border-short text-short")}
            onChange={(e) => {
              setSize(e.target.valueAsNumber);
              setQuote(null);
            }}
          />
        </Field>

        {type === "market" ? (
          <div className="text-[11.5px] text-muted">Fills at the executable Flash quote. Slippage shown in the quote.</div>
        ) : null}
        {type === "limit" || (type === "bracket" && isBuy) ? (
          <Field label="Limit price">
            <Input
              type="number"
              aria-label="Limit price"
              step={0.01}
              value={limitPx}
              onChange={(e) => setLimitPx(e.target.valueAsNumber)}
            />
          </Field>
        ) : null}
        {type === "stop" ? (
          <Field label="Trigger price" hint={side === "buy" ? "Stop-buy: fires when price rises to trigger" : "Stop-sell: fires when price falls to trigger"}>
            <Input
              type="number"
              aria-label="Trigger price"
              step={0.01}
              value={triggerPx}
              onChange={(e) => setTriggerPx(e.target.valueAsNumber)}
            />
          </Field>
        ) : null}
        {type === "trailing" ? (
          <Field label="Trail" hint="Stop trails the price by this percentage">
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                aria-label="Trail percent"
                step={0.1}
                min={0.5}
                max={50}
                value={trailPct}
                onChange={(e) => setTrailPct(e.target.valueAsNumber)}
              />
              <span className="text-[11px] text-muted">%</span>
            </div>
          </Field>
        ) : null}
        {type === "twap" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Duration (min)" hint="Flash minimum 5 min">
              <Input
                type="number"
                aria-label="TWAP duration minutes"
                min={5}
                step={1}
                value={twapMin}
                onChange={(e) => setTwapMin(e.target.valueAsNumber)}
              />
            </Field>
            <Field label="Buckets">
              <Input
                type="number"
                aria-label="TWAP buckets"
                min={2}
                max={48}
                step={1}
                value={twapBuckets}
                onChange={(e) => setTwapBuckets(e.target.valueAsNumber)}
              />
            </Field>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px]">Take-profit</span>
            <Switch label="Take-profit" checked={tpOn} onChange={setTpOn} />
          </div>
          {tpOn ? (
            <Input aria-label="Take-profit price" type="number" step={0.01} value={tpPx} onChange={(e) => setTpPx(e.target.valueAsNumber)} />
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-[12px]">Stop-loss</span>
            <Switch label="Stop-loss" checked={slOn} onChange={setSlOn} />
          </div>
          {slOn ? (
            <Input aria-label="Stop-loss price" type="number" step={0.01} value={slPx} onChange={(e) => setSlPx(e.target.valueAsNumber)} />
          ) : null}
          <div className="text-[11px] text-muted">Attached brackets protect entries on Market, Limit and TWAP.</div>
        </div>

        <dl className="num grid grid-cols-2 gap-y-1 text-[11.5px]">
          <dt className="text-muted">Integrator fee ({FLASH_INTEGRATOR_FEE_BPS / 100}%)</dt>
          <dd className="text-right">{fmtUsd(notionalFee, 4)}</dd>
          <dt className="text-muted">Flash network fee</dt>
          <dd className="text-right text-muted">from quote</dd>
          <dt className="text-muted">Reference price</dt>
          <dd className="text-right">{fmtAmount(refPx, 2)}</dd>
        </dl>

        {quote ? <QuotePanel quote={quote} asset={asset} busy={busy} onConfirm={() => confirm(quote)} onDismiss={() => setQuote(null)} /> : null}

        {!quote ? (
          <Button
            variant={isBuy ? "long" : "short"}
            className="h-9 w-full text-[13px]"
            disabled={!sizeOk || busy !== null}
            onClick={getQuote}
          >
            {mainLabel}
          </Button>
        ) : null}
        <p className="text-[11px] text-muted">
          {live
            ? "Quotes come from Definitive Flash and expire after 2 minutes. Your wallet signs each order and approval."
            : "Paper mode: quotes are estimates and fills are simulated. Nothing is sent to Flash."}
        </p>
      </div>
    </section>
  );
}

function QuotePanel({
  quote,
  asset,
  busy,
  onConfirm,
  onDismiss,
}: {
  quote: TradeQuote;
  asset: string;
  busy: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg p-2.5 text-[11.5px]">
      <div className="flex items-center justify-between">
        <span className="font-medium">{quote.mode === "paper" ? "Simulated quote" : "Flash quote"}</span>
        <button type="button" className="text-muted hover:text-text" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {quote.mode === "paper" ? (
        <>
          <div className="num">
            Fill at {fmtAmount(quote.priceUsd, 2)} · fee {fmtUsd(quote.feeUsd, 4)}
          </div>
          <div className="text-muted">{quote.note}</div>
          <Button variant="secondary" disabled={busy !== null} onClick={onConfirm}>
            Record simulated fill
          </Button>
        </>
      ) : (
        <>
          <div className="num">
            Receive {fmtAmount(Number(quote.receive.amount), 6)} {quote.receive.asset} · fee {fmtUsd(quote.feeUsd, 4)}
          </div>
          <div className="num text-muted">
            Price impact {quote.priceImpact ?? "n/a"} · recommended slippage {quote.recommendedSlippage ?? "n/a"}
          </div>
          <div className="text-muted">
            {quote.steps.length} onchain step{quote.steps.length === 1 ? "" : "s"}, then wallet signatures for {asset}.
          </div>
          <Button variant="long" disabled={busy !== null} onClick={onConfirm}>
            {busy ?? "Sign and submit"}
          </Button>
        </>
      )}
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
