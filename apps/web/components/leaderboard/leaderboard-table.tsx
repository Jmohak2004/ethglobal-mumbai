"use client";

import type { PerformanceStats } from "@arena/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type MouseEvent } from "react";

import { PaperBadge, SelfFundedBadge, VerifiedBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { TD, TH, THead, TR, Table, EmptyRow } from "@/components/ui/table";
import { fmtBps, fmtCompactUsd, fmtPct, fmtUsdSigned, pnlClass } from "@/lib/format";
import { getTemplate } from "@/lib/templates";

type SortKey = "rank" | "name" | "pnlPct" | "pnlUsd" | "winRate" | "dd" | "hit" | "trades" | "volume" | "forks";

interface Col {
  key: SortKey;
  label: string;
  align: "left" | "right";
}

const COLS: Col[] = [
  { key: "rank", label: "#", align: "left" },
  { key: "name", label: "Agent", align: "left" },
  { key: "pnlPct", label: "PnL %", align: "right" },
  { key: "pnlUsd", label: "PnL $", align: "right" },
  { key: "winRate", label: "Win rate", align: "right" },
  { key: "dd", label: "Max DD", align: "right" },
  { key: "hit", label: "Forecast hit", align: "right" },
  { key: "trades", label: "Trades", align: "right" },
  { key: "volume", label: "Volume", align: "right" },
  { key: "forks", label: "Forks", align: "right" },
];

interface Row {
  r: PerformanceStats;
  rank: number;
}

/** Sortable leaderboard. Rank is fixed by the default ordering (PnL %), not by the current sort. */
export function LeaderboardTable({ rows }: { rows: PerformanceStats[] }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });

  const ranked: Row[] = useMemo(() => rows.map((r, i) => ({ r, rank: i + 1 })), [rows]);

  const sorted = useMemo(() => {
    const val = (x: Row): number | string => {
      switch (sort.key) {
        case "rank":
          return x.rank;
        case "name":
          return x.r.name.toLowerCase();
        case "pnlPct":
          return x.r.realizedPnlPct;
        case "pnlUsd":
          return x.r.realizedPnlUsd;
        case "winRate":
          return x.r.winRateBps;
        case "dd":
          return x.r.maxDrawdownBps;
        case "hit":
          return x.r.forecastHitRateBps;
        case "trades":
          return x.r.trades;
        case "volume":
          return x.r.volumeUsd;
        case "forks":
          return x.r.forkCount;
      }
    };
    return [...ranked].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * sort.dir;
      if (va > vb) return 1 * sort.dir;
      return 0;
    });
  }, [ranked, sort]);

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: key === "name" || key === "rank" ? 1 : -1 },
    );
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, r: PerformanceStats) => {
    if (r.kind !== "agent") return;
    if ((e.target as HTMLElement).closest("a")) return;
    router.push(`/agents/${r.entityId}`);
  };

  return (
    <Table>
      <THead>
        <tr>
          {COLS.map((c) => (
            <TH key={c.key} align={c.align} className="cursor-pointer select-none hover:text-text">
              <button type="button" onClick={() => onSort(c.key)} className="uppercase tracking-wider">
                {c.label}
                {sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : null}
              </button>
            </TH>
          ))}
          <TH align="left">Badges</TH>
        </tr>
      </THead>
      <tbody>
        {sorted.length === 0 ? (
          <EmptyRow colSpan={COLS.length + 1}>No entries match these filters.</EmptyRow>
        ) : null}
        {sorted.map(({ r, rank }) => {
          const isAgent = r.kind === "agent";
          const tpl = r.template ? getTemplate(r.template) : undefined;
          return (
            <TR
              key={r.entityId}
              onClick={isAgent ? (e) => onRowClick(e, r) : undefined}
              className={isAgent ? "cursor-pointer" : undefined}
            >
              <TD className="text-muted">{rank}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  {isAgent ? (
                    <Link href={`/agents/${r.entityId}`} className="font-medium text-text hover:underline">
                      {r.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-text">{r.name}</span>
                  )}
                  {tpl ? <Badge tone="neutral">{tpl.name}</Badge> : <Badge tone="link">Human</Badge>}
                </div>
              </TD>
              <TD align="right" className={pnlClass(r.realizedPnlPct)}>
                {fmtPct(r.realizedPnlPct, 2, true)}
              </TD>
              <TD align="right" className={pnlClass(r.realizedPnlUsd)}>
                {fmtUsdSigned(r.realizedPnlUsd)}
              </TD>
              <TD align="right">{fmtBps(r.winRateBps)}</TD>
              <TD align="right" className="text-short">
                {r.maxDrawdownBps ? `-${fmtBps(r.maxDrawdownBps)}` : "0.0%"}
              </TD>
              <TD align="right">{isAgent ? fmtBps(r.forecastHitRateBps) : <span className="text-muted">n/a</span>}</TD>
              <TD align="right">{r.trades}</TD>
              <TD align="right">{fmtCompactUsd(r.volumeUsd)}</TD>
              <TD align="right">{isAgent ? r.forkCount : <span className="text-muted">n/a</span>}</TD>
              <TD>
                <div className="flex items-center gap-1.5">
                  <VerifiedBadge verified={r.verified} />
                  <SelfFundedBadge selfFunded={r.selfFunded} />
                  <PaperBadge mode={r.mode} />
                </div>
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}
