"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Tabs, type TabItem } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { TEMPLATES, TIMEFRAMES } from "@/lib/templates";

type Kind = "agent" | "human" | "all";

const KINDS: TabItem<Kind>[] = [
  { value: "agent", label: "Agents" },
  { value: "human", label: "Humans" },
  { value: "all", label: "All" },
];

const MODES = [
  { value: "all", label: "Live + Paper" },
  { value: "live", label: "Live" },
  { value: "paper", label: "Paper" },
];

const selectCls =
  "h-7 rounded-md border border-border bg-panel px-2 text-[12px] text-text focus:border-link focus:outline-none";

/**
 * Kind tabs and filters. State lives in the URL so the server re-renders the leaderboard.
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
      <Tabs value={kind} items={KINDS} onChange={(v) => update("kind", v)} className="border-b-0" />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Template"
          className={selectCls}
          value={template}
          onChange={(e) => update("template", e.target.value)}
        >
          <option value="all">All templates</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {windowedStats ? (
          <select
            aria-label="Timeframe"
            className={selectCls}
            value={timeframe}
            onChange={(e) => update("timeframe", e.target.value)}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        ) : (
          <Tooltip side="bottom" align="end" content={<span>windowed stats coming soon</span>}>
            <select aria-label="Timeframe" aria-disabled="true" className={`${selectCls} cursor-not-allowed opacity-70`} value="all" onChange={() => undefined}>
              <option value="all">All time</option>
            </select>
          </Tooltip>
        )}
        <select aria-label="Mode" className={selectCls} value={mode} onChange={(e) => update("mode", e.target.value)}>
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
