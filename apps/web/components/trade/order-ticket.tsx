"use client";

import { clsx } from "clsx";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { placeOrder, type OrderTicket as Ticket } from "@/lib/trade";
import { DEMO_CAPS, FLASH_INTEGRATOR_FEE_BPS } from "@/lib/templates";
import { fmtAmount, fmtUsd } from "@/lib/format";

type TicketType = "market" | "limit" | "twap" | "stop" | "trailing" | "bracket";

const TYPES: TabItem<TicketType>[] = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
  { value: "twap", label: "TWAP" },
  { value: "stop", label: "Stop" },
  { value: "trailing", label: "Trailing" },
  { value: "bracket", label: "Bracket" },
];

const ORDER_TYPE: Record<TicketType, Ticket["orderType"]> = {
  market: "market",
  limit: "limit",
  twap: "twap",
  stop: "stop",
  trailing: "trailing-stop",
  bracket: "bracket",
};

export interface TicketPrefill {
  limitPx?: number;
  tpPx?: number;
  slPx?: number;
}

/** Order ticket for Flash order types. Submit calls lib/trade.ts placeOrder(), which is a stub for now. */
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
  const [submitting, setSubmitting] = useState(false);

  const sizeOk = Number.isFinite(size) && size >= 0.01 && size <= DEMO_CAPS.maxTradeUsd;
  const refPx = type === "stop" ? triggerPx : type === "market" ? markPrice : limitPx;
  const notionalFee = (Number.isFinite(size) ? size : 0) * (FLASH_INTEGRATOR_FEE_BPS / 10_000);
  const isBuy = side === "buy";

  const submit = async () => {
    setSubmitting(true);
    try {
      const ticket: Ticket = {
        side,
        asset,
        orderType: ORDER_TYPE[type],
        sizeUsd: size,
        ...(type === "limit" || type === "bracket" ? { limitPrice: limitPx } : {}),
        ...(type === "stop" ? { triggerPrice: triggerPx } : {}),
        ...(type === "trailing" ? { trailPct } : {}),
        ...(type === "twap" ? { twap: { durationMin: twapMin, buckets: twapBuckets } } : {}),
        ...(tpOn ? { takeProfitPrice: tpPx } : {}),
        ...(slOn ? { stopLossPrice: slPx } : {}),
      };
      const res = await placeOrder(ticket);
      toast({ title: "Order placed", description: res.orderId, tone: "success" });
    } catch (err) {
      toast({ title: "Order not sent", description: (err as Error).message, tone: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-panel" aria-label="Order ticket">
      <header className="flex h-8 items-center border-b border-border px-3 text-[10.5px] font-medium uppercase tracking-wider text-muted">
        Order ticket
      </header>
      <div className="flex flex-col gap-3 p-3">
        <Tabs value={type} items={TYPES} onChange={setType} className="overflow-x-auto" />

        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg p-0.5">
          <button
            type="button"
            aria-pressed={isBuy}
            onClick={() => setSide("buy")}
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
            onClick={() => setSide("sell")}
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
          hint={sizeOk ? `Demo max per trade ${fmtUsd(DEMO_CAPS.maxTradeUsd, 2)}` : `Enter 0.01 to ${DEMO_CAPS.maxTradeUsd} (demo cap)`}
        >
          <Input
            type="number"
            aria-label="Size in USD"
            min={0.01}
            max={DEMO_CAPS.maxTradeUsd}
            step={0.01}
            value={Number.isFinite(size) ? size : ""}
            className={clsx(!sizeOk && "border-short text-short")}
            onChange={(e) => setSize(e.target.valueAsNumber)}
          />
        </Field>

        {type === "market" ? (
          <div className="text-[11.5px] text-muted">Fills at the executable Flash quote. Slippage shown at submit.</div>
        ) : null}
        {type === "limit" || type === "bracket" ? (
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
                min={0.1}
                value={trailPct}
                onChange={(e) => setTrailPct(e.target.valueAsNumber)}
              />
              <span className="text-[11px] text-muted">%</span>
            </div>
          </Field>
        ) : null}
        {type === "twap" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Duration (min)">
              <Input
                type="number"
                aria-label="TWAP duration minutes"
                min={1}
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
          <div className="text-[11px] text-muted">Attached brackets protect the position even if our servers are down.</div>
        </div>

        <dl className="num grid grid-cols-2 gap-y-1 text-[11.5px]">
          <dt className="text-muted">Integrator fee ({FLASH_INTEGRATOR_FEE_BPS / 100}%)</dt>
          <dd className="text-right">{fmtUsd(notionalFee, 4)}</dd>
          <dt className="text-muted">Flash network fee</dt>
          <dd className="text-right text-muted">from quote</dd>
          <dt className="text-muted">Reference price</dt>
          <dd className="text-right">{fmtAmount(refPx, 2)}</dd>
        </dl>

        <Button
          variant={isBuy ? "long" : "short"}
          className="h-9 w-full text-[13px]"
          disabled={!sizeOk || submitting}
          onClick={submit}
        >
          {submitting ? "Submitting…" : `${isBuy ? "Buy" : "Sell"} ${asset}`}
        </Button>
        <p className="text-[11px] text-muted">Wallet signing (Flash EIP-712 + Permit2) is not connected yet. Orders will not be sent.</p>
      </div>
    </section>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
