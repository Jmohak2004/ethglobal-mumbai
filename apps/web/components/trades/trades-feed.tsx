"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconTrophy } from "@/components/ui/icons";
import { StatCard } from "@/components/ui/stat-card";
import { TD, TH, THead, TR, Table } from "@/components/ui/table";
import { getJson } from "@/lib/api";
import { fmtAmount, fmtCompactUsd, fmtDateTime, fmtNum, fmtUsd } from "@/lib/format";
import type { TradeRow, TradesPage, TradesSummary } from "@/lib/types";

const POLL_MS = 10_000;

/** The BaseScan link for one trade: the settlement tx for live fills, the TradeJournal tx for paper fills. */
export function TradeTxLink({ t }: { t: Pick<TradeRow, "mode" | "txId" | "explorerUrl"> }) {
  if (!t.txId || !t.explorerUrl) {
    return (
      <span className="text-muted" title="The worker journals every paper fill on Base Sepolia within about a minute.">
        journaling…
      </span>
    );
  }
  return (
    <a
      href={t.explorerUrl}
      target="_blank"
      rel="noreferrer"
      title={t.mode === "paper" ? `Journaled on Base Sepolia · ${t.txId}` : `Settled on Base · ${t.txId}`}
      className="font-medium text-accent-fg hover:underline"
    >
      BaseScan ↗
    </a>
  );
}

/** One trade per row: time, trader, side, asset, size, price, mode, BaseScan link. Shared by /trades and agent pages. */
export function TradeTable({ rows, showTrader = true, bare }: { rows: TradeRow[]; showTrader?: boolean; bare?: boolean }) {
  return (
    <Table bare={bare}>
      <THead>
        <tr>
          <TH>Time (UTC)</TH>
          {showTrader ? <TH>Trader</TH> : null}
          <TH>Side</TH>
          <TH>Asset</TH>
          <TH align="right">Size</TH>
          <TH align="right">Price</TH>
          <TH>Mode</TH>
          <TH>Transaction</TH>
        </tr>
      </THead>
      <tbody>
        {rows.map((t) => (
          <TR key={t.id}>
            <TD className="num text-muted">{fmtDateTime(t.ts).replace(" UTC", "")}</TD>
            {showTrader ? (
              <TD>
                {t.trader.agentId ? (
                  <Link href={`/agents/${t.trader.agentId}`} className="font-medium text-text hover:underline">
                    {t.trader.name}
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span className="num font-medium text-text">{t.trader.name}</span>
                    <Badge tone="accent">Human</Badge>
                  </span>
                )}
              </TD>
            ) : null}
            <TD className={t.side === "buy" ? "font-medium text-long" : "font-medium text-short"}>{t.side}</TD>
            <TD>{t.asset}</TD>
            <TD align="right">{fmtUsd(t.sizeUsd)}</TD>
            <TD align="right">{fmtAmount(t.priceUsd, 2)}</TD>
            <TD>
              {t.mode === "paper" ? (
                <Badge tone="warn">paper</Badge>
              ) : (
                <Badge tone="success">live</Badge>
              )}
            </TD>
            <TD>
              <TradeTxLink t={t} />
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

export function TradesSummaryStrip({ summary }: { summary: TradesSummary }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard label="Total trades" value={fmtNum(summary.trades)} sub="Every fill, agents and humans" />
      <StatCard label="Total volume" value={fmtCompactUsd(summary.volumeUsd)} sub="USD traded across all fills" />
      <StatCard
        label="Journaled onchain"
        value={fmtNum(summary.journaled)}
        sub={`${fmtNum(Math.max(0, summary.trades - summary.journaled))} still journaling`}
        help="Paper fills are recorded on Base Sepolia by the TradeJournal contract; live fills carry their Base settlement transaction."
      />
    </div>
  );
}

/**
 * Live list of fills, newest first. Server-rendered first page, then polled every 10 s. Older pages load on demand.
 * Pass agentId to show one agent's trades only.
 */
export function TradesFeed({
  initial,
  agentId,
  limit = 100,
  showSummary = false,
}: {
  initial: TradesPage;
  agentId?: string;
  limit?: number;
  showSummary?: boolean;
}) {
  const [older, setOlder] = useState<TradeRow[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  const qs = (cursor?: string) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (agentId) p.set("agentId", agentId);
    if (cursor) p.set("cursor", cursor);
    return `/api/trades?${p}`;
  };

  const { data } = useQuery({
    queryKey: ["trades", agentId ?? "all", limit],
    queryFn: () => getJson<TradesPage>(qs()),
    initialData: initial,
    refetchInterval: POLL_MS,
    staleTime: 0,
  });

  const head = data ?? initial;
  const headIds = new Set(head.trades.map((t) => t.id));
  const rows = [...head.trades, ...older.filter((t) => !headIds.has(t.id))];
  const cursor = olderCursor === undefined ? head.nextCursor : olderCursor;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await getJson<TradesPage>(qs(cursor));
      setOlder((prev) => [...prev, ...page.trades]);
      setOlderCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {showSummary ? <TradesSummaryStrip summary={head.summary} /> : null}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]">
          <EmptyState
            icon={<IconTrophy size={18} />}
            title="No trades yet"
            description="Trades show up here the moment they fill, each with its BaseScan link."
          />
        </div>
      ) : (
        <TradeTable rows={rows} showTrader={!agentId} bare={Boolean(agentId)} />
      )}
      {cursor ? (
        <div className="flex items-center justify-center gap-3">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load older trades"}
          </Button>
          {moreError ? <span className="text-sm text-short">Could not load more. Try again.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
