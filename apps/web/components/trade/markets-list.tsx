"use client";

import { clsx } from "clsx";
import { useMemo, useState, type KeyboardEvent } from "react";

import { Panel } from "@/components/ui/panel";
import { fmtPct, pnlClass } from "@/lib/format";
import { categoryOf } from "@/lib/live/categories";
import { formatPrice } from "@/lib/live/price-format";
import { useTicker } from "@/lib/live/use-live";

/** Searchable list of every tradable market with live last price and 24h change. Click to switch the terminal. */
export function MarketsList({
  assets,
  products,
  active,
  onSelect,
}: {
  assets: string[];
  products: Record<string, string>;
  active: string;
  onSelect: (asset: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      assets.filter((a) => {
        if (!q) return true;
        return (
          a.toLowerCase().includes(q) ||
          categoryOf(a).toLowerCase().includes(q) ||
          (products[a] ?? "").toLowerCase().includes(q)
        );
      }),
    [assets, products, q],
  );

  // Enter picks the first match, so search-then-select works from the keyboard.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const first = rows[0];
    if (e.key === "Enter" && first) onSelect(first);
  };

  return (
    <Panel
      title={`Markets · ${assets.length}`}
      className="h-[320px] xl:h-[560px]"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-border p-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search symbol or category"
          aria-label="Search markets"
          className="h-7 w-full rounded-md border border-border bg-bg px-2 text-[12px] text-text placeholder:text-muted focus:border-border-strong focus:outline-none"
        />
      </div>
      <div className="grid grid-cols-[1fr_84px_64px] gap-2 border-b border-border px-3 py-1 text-[10px] uppercase tracking-wider text-muted">
        <span>Market</span>
        <span className="text-right">Last</span>
        <span className="text-right">24h</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((a) => (
          <li key={a}>
            <MarketRow asset={a} product={products[a] ?? null} active={a === active} onSelect={onSelect} />
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-3 py-6 text-center text-[12px] text-muted">No markets match “{query}”.</li>
        ) : null}
      </ul>
    </Panel>
  );
}

function MarketRow({
  asset,
  product,
  active,
  onSelect,
}: {
  asset: string;
  product: string | null;
  active: boolean;
  onSelect: (asset: string) => void;
}) {
  const t = useTicker(product);
  const dir = t?.dir ?? "flat";
  const priceClass = dir === "up" ? "text-long" : dir === "down" ? "text-short" : "text-text";
  const change = t?.change24hPct;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={product ?? asset}
      onClick={() => onSelect(asset)}
      className={clsx(
        "grid w-full grid-cols-[1fr_84px_64px] items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
        active ? "bg-panel-2" : "hover:bg-panel-2",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium text-text">{asset}</span>
        <span className="truncate text-[9.5px] uppercase tracking-wide text-muted">{categoryOf(asset)}</span>
      </span>
      <span className={`num text-right ${priceClass}`}>{t ? formatPrice(t.price) : "—"}</span>
      <span className={`num text-right ${change === undefined ? "text-muted" : pnlClass(change)}`}>
        {change === undefined ? "—" : fmtPct(change, 2, true)}
      </span>
    </button>
  );
}
