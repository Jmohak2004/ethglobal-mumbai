"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { fmtPct, pnlClass } from "@/lib/format";

export interface ShareCard {
  id: string;
  name: string;
  templateName: string;
  pnlPct: number;
  pnlUsd: number;
  winRatePct: number;
  trades: number;
  rank: number | null;
  verified: boolean;
}

/** Stats-only share card (no trade details, per PRD 6.9). Image is a local SVG until 0G image generation lands. */
export function ShareCardButton({ card }: { card: ShareCard }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Share card</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Share card" width="max-w-xl">
        {open ? <ShareCardBody card={card} /> : null}
      </Modal>
    </>
  );
}

function cardSvg(card: ShareCard): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const pnl = `${card.pnlPct >= 0 ? "+" : ""}${card.pnlPct.toFixed(2)}%`;
  const color = card.pnlPct >= 0 ? "#50d2c1" : "#ed7088";
  const sub = [card.templateName, card.rank ? `rank #${card.rank}` : null, card.verified ? "Verified by Chainlink CRE" : null]
    .filter(Boolean)
    .join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0b1417"/>
<rect x="40" y="40" width="1120" height="550" rx="16" fill="#0f1a1e" stroke="#1c2d34" stroke-width="2"/>
<text x="80" y="110" fill="#e6f0ee" font-family="monospace" font-size="28" letter-spacing="6">ARENA</text>
<text x="80" y="220" fill="#e6f0ee" font-family="sans-serif" font-size="64" font-weight="700">${esc(card.name)}</text>
<text x="80" y="275" fill="#8a9a98" font-family="sans-serif" font-size="28">${esc(sub)}</text>
<text x="80" y="420" fill="${color}" font-family="monospace" font-size="120" font-weight="700">${pnl}</text>
<text x="80" y="500" fill="#8a9a98" font-family="monospace" font-size="30">win rate ${card.winRatePct.toFixed(1)}%   trades ${card.trades}</text>
<text x="80" y="555" fill="#8a9a98" font-family="sans-serif" font-size="22">Stats only. No trade details.</text>
</svg>`;
}

function ShareCardBody({ card }: { card: ShareCard }) {
  const toast = useToast();
  const url = `${window.location.origin}/agents/${card.id}`;
  const text = `${card.name} on ARENA: ${fmtPct(card.pnlPct, 2, true)} PnL, ${card.winRatePct.toFixed(1)}% win rate, ${card.trades} trades${card.rank ? `, #${card.rank} on the leaderboard` : ""}. Verified by Chainlink CRE.`;
  const xHref = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const tgHref = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

  const download = () => {
    const blob = new Blob([cardSvg(card)], { type: "image/svg+xml" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${card.id}-card.svg`;
    a.click();
    URL.revokeObjectURL(href);
    toast({ title: "Card downloaded", tone: "success" });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 rounded-md border border-border bg-bg p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold tracking-[0.25em]">ARENA</span>
          {card.verified ? <Badge tone="link">✓ CRE</Badge> : null}
        </div>
        <div>
          <div className="text-[22px] font-semibold">{card.name}</div>
          <div className="text-[12px] text-muted">
            {card.templateName}
            {card.rank ? ` · #${card.rank}` : ""}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">PnL</div>
            <div className={`num text-[24px] font-semibold ${pnlClass(card.pnlPct)}`}>
              {fmtPct(card.pnlPct, 2, true)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">Win rate</div>
            <div className="num text-[24px] font-semibold">{card.winRatePct.toFixed(1)}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">Trades</div>
            <div className="num text-[24px] font-semibold">{card.trades}</div>
          </div>
        </div>
        <div className="text-[10.5px] text-muted">Stats only. Verified by Chainlink CRE. No trade details.</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={xHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center rounded-md border border-border bg-panel-2 px-3 text-[12px] font-medium text-text hover:bg-border"
        >
          Share on X
        </a>
        <a
          href={tgHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center rounded-md border border-border bg-panel-2 px-3 text-[12px] font-medium text-text hover:bg-border"
        >
          Telegram
        </a>
        <Button onClick={download}>Download image</Button>
      </div>
    </div>
  );
}
