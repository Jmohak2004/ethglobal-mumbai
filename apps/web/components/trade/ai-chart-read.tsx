"use client";

import type { MarketSnapshot } from "@arena/shared";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { TicketPrefill } from "@/components/trade/order-ticket";
import { describeError, postJson } from "@/lib/api";
import { fmtAmount, fmtPct } from "@/lib/format";
import { zgKeyHeaders } from "@/lib/user-keys";
import type { ChartReadResult } from "@/lib/types";

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

/**
 * "AI chart read". Upload or paste a chart screenshot, and the 0G vision model returns trend, key levels and a
 * suggested bracket. The indicator-based read from the candles stays as the baseline. Billing: your own 0G
 * key when set in settings, otherwise the platform key (sign-in required).
 */
export function AiChartRead({
  open,
  onClose,
  market,
  onPrefill,
}: {
  open: boolean;
  onClose: () => void;
  market: MarketSnapshot;
  onPrefill: (p: TicketPrefill) => void;
}) {
  const toast = useToast();
  const [image, setImage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ChartReadResult | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFile = useCallback(
    (file: File) => {
      if (!ACCEPT.includes(file.type)) {
        toast({ title: "Unsupported image", description: "Use PNG, JPEG or WebP.", tone: "error" });
        return;
      }
      if (file.size > MAX_BYTES) {
        toast({ title: "Image too large", description: "Keep screenshots under 2 MB.", tone: "error" });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setImage(String(reader.result));
        setAnalysis(null);
      };
      reader.readAsDataURL(file);
    },
    [toast],
  );

  // Paste a screenshot anywhere while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) loadFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open, loadFile]);

  const analyze = async () => {
    if (!image) return;
    setBusy(true);
    try {
      setAnalysis(await postJson<ChartReadResult>("/api/ai/chart", { image, asset: market.asset }, zgKeyHeaders()));
    } catch (err) {
      toast({ title: "AI read unavailable", description: `${describeError(err)}. The indicator read is still shown.`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const ind = market.indicators;
  const px = market.priceUsd;
  const trend = ind.emaFast > ind.emaSlow ? "Uptrend (EMA12 above EMA26)" : "Downtrend (EMA12 below EMA26)";
  const rsiState = ind.rsi14 >= 70 ? "overbought" : ind.rsi14 <= 30 ? "oversold" : "neutral";
  const entry = Math.round(px * 0.998 * 100) / 100;
  const tp = Math.round((px + 1.5 * ind.atr14) * 100) / 100;
  const sl = Math.round((px - 1 * ind.atr14) * 100) / 100;

  const aiTp = analysis ? Math.round(px * (1 + (analysis.suggestedSliders.takeProfitPct ?? 4) / 100) * 100) / 100 : null;
  const aiSl = analysis ? Math.round(px * (1 - (analysis.suggestedSliders.stopLossPct ?? 2) / 100) * 100) / 100 : null;

  return (
    <Modal open={open} onClose={onClose} title={`AI chart read · ${market.asset} 1h`} width="max-w-lg">
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div
          className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3"
          tabIndex={0}
          aria-label="Chart image drop zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) loadFile(file);
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-border bg-panel-2 px-3 text-[12px] font-medium hover:bg-border">
              Upload chart
              <input
                type="file"
                accept={ACCEPT.join(",")}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadFile(file);
                }}
              />
            </label>
            <span className="text-[11.5px] text-muted">or paste a screenshot (Cmd/Ctrl+V)</span>
          </div>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="Chart preview" className="max-h-48 w-full rounded object-contain" />
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">
              {analysis
                ? analysis.payer === "user"
                  ? "Billed to your 0G account"
                  : "Billed to the platform 0G key"
                : "Billed to your 0G account when you set a key in settings, otherwise the platform key."}
            </span>
            <Button variant="primary" disabled={!image || busy} onClick={analyze}>
              {busy ? "Reading chart…" : "Analyze"}
            </Button>
          </div>
        </div>

        {analysis ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted">AI read</span>
              <Badge tone={analysis.trend === "bullish" ? "accent" : analysis.trend === "bearish" ? "warn" : "neutral"}>
                {analysis.trend}
              </Badge>
              {analysis.teeVerified ? <Badge tone="link">TEE verified</Badge> : null}
            </div>
            <p className="text-[12px] text-text">{analysis.summary}</p>
            <div className="num text-[11.5px] text-muted">
              Key levels: {analysis.keyLevels.length ? analysis.keyLevels.map((l) => fmtAmount(l, 2)).join(", ") : "none read"} · template{" "}
              {analysis.suggestedTemplate} · request {analysis.requestId || "n/a"}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted">Indicator read</span>
            <Badge>no AI</Badge>
          </div>
          <dl className="num grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-muted">Trend</dt>
            <dd>{trend}</dd>
            <dt className="text-muted">Momentum (ROC)</dt>
            <dd>{fmtPct(ind.rocPct, 2, true)} over 10 bars</dd>
            <dt className="text-muted">RSI(14)</dt>
            <dd>
              {fmtAmount(ind.rsi14, 1)} · {rsiState}
            </dd>
            <dt className="text-muted">Range (20 bars)</dt>
            <dd>
              {fmtAmount(ind.rangeLow, 2)} to {fmtAmount(ind.rangeHigh, 2)}
            </dd>
            <dt className="text-muted">Volatility</dt>
            <dd>{fmtPct(ind.volatilityPct, 2)} per bar (stdev)</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border p-3">
          <div className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted">
            Suggested bracket {analysis ? "(AI sliders)" : "(ATR)"}
          </div>
          <dl className="num grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-[10px] text-muted">Entry</dt>
              <dd>{fmtAmount(entry, 2)}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted">Take-profit</dt>
              <dd className="text-long">{fmtAmount(aiTp ?? tp, 2)}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted">Stop-loss</dt>
              <dd className="text-short">{fmtAmount(aiSl ?? sl, 2)}</dd>
            </div>
          </dl>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Dismiss
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onPrefill({ limitPx: entry, tpPx: aiTp ?? tp, slPx: aiSl ?? sl });
              onClose();
            }}
          >
            Prefill ticket
          </Button>
        </div>
      </div>
    </Modal>
  );
}
