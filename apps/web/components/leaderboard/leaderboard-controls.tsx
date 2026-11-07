"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { TEMPLATES, TIMEFRAMES } from "@/lib/templates";

type Kind = "agent" | "human" | "all";

const KINDS: { value: Kind; label: string }[] = [
  { value: "agent", label: "Agents" },
  { value: "human", label: "Humans" },
  { value: "all", label: "Everyone" },
];

const MODES = [
  { value: "all", label: "Live and paper" },
  { value: "live", label: "Live only" },
  { value: "paper", label: "Paper only" },
];

const selectCls =
  "h-9 rounded-lg border border-border-strong bg-panel px-3 text-base text-text shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-150 hover:border-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/20";

/**
 * Kind switch and filters. State lives in the URL so the server re-renders the leaderboard.
 * `windowedStats` is false on the DB path, which serves all-time stats only: the timeframe control then shows
 * "All time" alone instead of a filter that does nothing.
 */
export function LeaderboardControls({ windowedStats }: { windowedStats: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const kind = (sp.get("kind") ?? "agent") as Kind;
  const template = sp.get("template") ?? "all";
  const timeframe = sp.get("timeframe") ?? "all";
  const mode = sp.get("mode") ?? "all";

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    const isDefault = value === "all" || (key === "kind" && value === "agent");
    if (isDefault) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Segmented label="Who to show" value={kind} options={KINDS} onChange={(v) => update("kind", v)} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Strategy" className={selectCls} value={template} onChange={(e) => update("template", e.target.value)}>
          <option value="all">All strategies</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {windowedStats ? (
          <select aria-label="Time period" className={selectCls} value={timeframe} onChange={(e) => update("timeframe", e.target.value)}>
            {TIMEFRAMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        ) : (
          <Tooltip side="bottom" align="end" focusable={false} content="Shorter time periods are coming soon.">
            <select aria-label="Time period" aria-disabled="true" className={`${selectCls} cursor-not-allowed opacity-70`} value="all" onChange={() => undefined}>
              <option value="all">All time</option>
            </select>
          </Tooltip>
        )}
        <select aria-label="Trading mode" className={selectCls} value={mode} onChange={(e) => update("mode", e.target.value)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
