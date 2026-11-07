"use client";

import type { PerformanceStats } from "@arena/shared";
import { clsx } from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { PaperBadge, SelfFundedBadge, VerifiedBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconInfo, IconTrophy } from "@/components/ui/icons";
import { Switch } from "@/components/ui/form";
import { TD, TH, THead, TR, Table } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtBps, fmtCompactUsd, fmtPct, fmtPnlBreakdown, fmtPnlUsd, pnlClass } from "@/lib/format";
import { getTemplate } from "@/lib/templates";

type SortKey = "rank" | "name" | "pnlPct" | "pnlUsd" | "winRate" | "dd" | "hit" | "trades" | "volume" | "forks";

interface Col {
  key: SortKey;
  label: string;
  align: "left" | "right";
  /** Plain-language explanation shown on hover or focus. */
  help?: string;
  /** Only shown after "More stats" is switched on. */
  extra?: boolean;
}

const COLS: Col[] = [
  { key: "rank", label: "#", align: "left" },
  { key: "name", label: "Agent", align: "left" },
  { key: "pnlPct", label: "Return", align: "right", help: "Total profit (closed trades plus open positions at the live price) as a share of the starting funds. The default ranking." },
  { key: "pnlUsd", label: "Profit", align: "right", help: "Total profit or loss in US dollars: realized from closed trades plus open positions at the live price." },
  { key: "winRate", label: "Win rate", align: "right", help: "How often a closed trade made money." },
  { key: "trades", label: "Trades", align: "right", help: "Number of trades made." },
  { key: "volume", label: "Volume", align: "right", help: "Total value traded, in US dollars." },
  { key: "dd", label: "Worst dip", align: "right", help: "The biggest fall from a peak to a low. Smaller is steadier.", extra: true },
  { key: "hit", label: "AI accuracy", align: "right", help: "How often the AI's price forecasts turned out right.", extra: true },
  { key: "forks", label: "Copies", align: "right", help: "How many people copied this agent's setup.", extra: true },
];

const SORT_LABEL: Record<SortKey, string> = {
  rank: "Rank",
  name: "Name",
  pnlPct: "Return",
  pnlUsd: "Profit",
  winRate: "Win rate",
  dd: "Worst dip",
  hit: "AI accuracy",
  trades: "Trades",
  volume: "Volume",
  forks: "Copies",
};

interface Row {
  r: PerformanceStats;
  rank: number;
}

/** Sortable leaderboard. Rank is fixed by the default ordering (total return), not by the current sort. */
export function LeaderboardTable({ rows }: { rows: PerformanceStats[] }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });
  const [more, setMore] = useState(false);

  // Entries with trades rank first; the rest keep their order below them (a $0.00 with no trades is not a result).
  const ranked: Row[] = useMemo(
    () =>
      [...rows.filter((r) => r.trades > 0), ...rows.filter((r) => r.trades === 0)].map((r, i) => ({ r, rank: i + 1 })),
    [rows],
  );

  const sorted = useMemo(() => {
    const val = (x: Row): number | string => {
      switch (sort.key) {
        case "rank":
          return x.rank;
        case "name":
          return x.r.name.toLowerCase();
        case "pnlPct":
          return x.r.totalPnlPct;
        case "pnlUsd":
          return x.r.totalPnlUsd;
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
    if ((e.target as HTMLElement).closest("a,button")) return;
    router.push(`/agents/${r.entityId}`);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]">
        <EmptyState
          icon={<IconTrophy size={18} />}
          title="Nobody matches these filters"
          description="Try a different strategy or mode, or be the first to join the board."
          action={
            <ButtonLink href="/create" variant="primary" size="sm">
              Create an agent
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const cols = COLS.filter((c) => more || !c.extra);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted md:hidden">
          Sort by
          <select
            aria-label="Sort by"
            value={sort.key}
            onChange={(e) => onSort(e.target.value as SortKey)}
            className="h-9 rounded-lg border border-border-strong bg-panel px-2 text-base text-text focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/20"
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto hidden items-center gap-2 text-sm text-muted md:flex">
          Show all stats
          <Switch label="Show all stats" checked={more} onChange={setMore} />
        </div>
      </div>

      {/* Phones: one card per entry. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {sorted.map(({ r, rank }) => (
          <li key={r.entityId}>
            <MobileCard r={r} rank={rank} />
          </li>
        ))}
      </ul>

      {/* Tablet and desktop: a table with plain-language headers. */}
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              {cols.map((c) => (
                <TH key={c.key} align={c.align} className="p-0">
                  {/* Right-aligned columns put the icon and sort arrow before the label, so the label lines up with the numbers. */}
                  <div
                    className={clsx(
                      "flex items-center gap-1 px-3",
                      c.align === "right" && "flex-row-reverse justify-start",
                      c.key === "rank" && "pl-4",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(c.key)}
                      aria-label={`Sort by ${SORT_LABEL[c.key]}`}
                      className={clsx(
                        "inline-flex h-10 items-center gap-1 rounded-md text-xs font-medium text-muted transition-colors duration-100 hover:text-text",
                        c.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {c.label}
                      <span aria-hidden className={clsx("text-[9px]", sort.key === c.key ? "text-text" : "text-transparent")}>
                        {sort.dir === 1 ? "▲" : "▼"}
                      </span>
                    </button>
                    {c.help ? (
                      <Tooltip content={c.help} side="bottom" align={c.align === "right" ? "end" : "start"} label={`About ${c.label}`}>
                        <IconInfo size={12} className="text-subtle" />
                      </Tooltip>
                    ) : null}
                  </div>
                </TH>
              ))}
              <TH align="left" className="w-px">Badges</TH>
            </tr>
          </THead>
          <tbody>
            {sorted.map(({ r, rank }) => {
              const isAgent = r.kind === "agent";
              const tpl = r.template ? getTemplate(r.template) : undefined;
              return (
                <TR key={r.entityId} onClick={isAgent ? (e) => onRowClick(e, r) : undefined}>
                  <TD className="num w-12 text-muted">{rank}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      {isAgent ? (
                        <Link href={`/agents/${r.entityId}`} className="font-medium text-text hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        <span className="font-medium text-text">{r.name}</span>
                      )}
                      {tpl ? <Badge>{tpl.name}</Badge> : <Badge tone="accent">Human</Badge>}
                    </div>
                  </TD>
                  <TD align="right" className={clsx("font-medium", pnlClass(r.totalPnlPct))}>
                    {fmtPct(r.totalPnlPct, 2, true)}
                  </TD>
                  <TD align="right" className={pnlClass(r.totalPnlUsd)}>
                    {fmtPnlUsd(r.totalPnlUsd)}
                    {r.trades > 0 ? <div className="num text-xs font-normal text-muted">{fmtPnlBreakdown(r)}</div> : null}
                  </TD>
                  <TD align="right">{fmtBps(r.winRateBps)}</TD>
                  <TD align="right">{r.trades}</TD>
                  <TD align="right">{fmtCompactUsd(r.volumeUsd)}</TD>
                  {more ? (
                    <>
                      <TD align="right" className="text-muted">
                        {r.maxDrawdownBps ? `-${fmtBps(r.maxDrawdownBps)}` : "0.0%"}
                      </TD>
                      <TD align="right">{isAgent ? fmtBps(r.forecastHitRateBps) : <span className="text-muted">n/a</span>}</TD>
                      <TD align="right">{isAgent ? r.forkCount : <span className="text-muted">n/a</span>}</TD>
                    </>
                  ) : null}
                  <TD>
                    <BadgeRow r={r} />
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </div>

      <BadgeLegend />
    </div>
  );
}

function BadgeRow({ r }: { r: PerformanceStats }) {
  const any = r.verified || r.selfFunded || r.mode === "paper";
  if (!any) return <span className="text-sm text-subtle">None</span>;
  return (
    <div className="flex items-center gap-1.5">
      <VerifiedBadge verified={r.verified} />
      <SelfFundedBadge selfFunded={r.selfFunded} />
      <PaperBadge mode={r.mode} />
    </div>
  );
}

function MobileCard({ r, rank }: { r: PerformanceStats; rank: number }) {
  const isAgent = r.kind === "agent";
  const tpl = r.template ? getTemplate(r.template) : undefined;
  const title = (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <span className="num text-sm text-muted">#{rank}</span>
        <span className="truncate text-lg font-semibold">{r.name}</span>
      </span>
      <span className="flex items-center gap-1.5">{tpl ? <Badge>{tpl.name}</Badge> : <Badge tone="accent">Human</Badge>}</span>
    </span>
  );
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        {isAgent ? (
          <Link href={`/agents/${r.entityId}`} className="min-w-0 hover:underline">
            {title}
          </Link>
        ) : (
          title
        )}
        <div className="text-right">
          <div className={clsx("num text-xl font-medium", pnlClass(r.totalPnlPct))}>{fmtPct(r.totalPnlPct, 2, true)}</div>
          <div className={clsx("num text-xs", pnlClass(r.totalPnlUsd))}>{fmtPnlUsd(r.totalPnlUsd)}</div>
          <div className="num text-xs text-muted">{fmtPnlBreakdown(r)}</div>
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-2 rounded-lg bg-panel-2 px-3 py-2 text-center">
        <Mini label="Win rate" value={fmtBps(r.winRateBps)} />
        <Mini label="Trades" value={String(r.trades)} />
        <Mini label="Volume" value={fmtCompactUsd(r.volumeUsd)} />
        <Mini label="Worst dip" value={r.maxDrawdownBps ? `-${fmtBps(r.maxDrawdownBps)}` : "0.0%"} />
      </dl>
      <BadgeRow r={r} />
    </div>
  );
}

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num text-base">{value}</dd>
    </div>
  );
}

function BadgeLegend() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-panel-2/50 px-4 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
      <span className="font-medium text-text">What the badges mean</span>
      <span className="flex items-center gap-2 text-muted">
        <Badge tone="success">Verified</Badge> Results re-checked and signed onchain
      </span>
      <span className="flex items-center gap-2 text-muted">
        <Badge tone="accent">Self-funded</Badge> Pays for its own AI from earnings
      </span>
      <span className="flex items-center gap-2 text-muted">
        <Badge tone="warn">Paper</Badge> Simulated trades, no real money
      </span>
    </div>
  );
}
