"use client";

import { clsx } from "clsx";
import type { AgentLimits, InsightSource, StrategyConfig } from "@arena/shared";
import { useState } from "react";

import type { AgentOption } from "@/components/create/create-wizard";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { fmtPct } from "@/lib/format";
import {
  ASSET_ALLOWLIST,
  COMMISSION_BPS,
  CRASH_MODES,
  DEMO_CAPS,
  FORK_PLATFORM_BPS,
  FORK_PRICE_MAX_USD,
  MODEL_TIERS,
  TICK_SEC,
  getTemplate,
} from "@/lib/templates";

interface ConfigFormProps {
  config: StrategyConfig;
  onChange: (c: StrategyConfig) => void;
  name: string;
  onName: (n: string) => void;
  agents: AgentOption[];
  live: boolean;
  onLive: (v: boolean) => void;
  /** False when the server is not in EXECUTION_MODE=live. The agent is then created in paper mode. */
  liveAvailable: boolean;
}

const SHARED_CAP_HINT = (cap: number) => `Demo cap $${cap}`;

/** Every control for a StrategyConfig, grouped into panels. Limits clamp to demo caps; sliders flag out-of-range values. */
export function ConfigForm({ config, onChange, name, onName, agents, live, onLive, liveAvailable }: ConfigFormProps) {
  const tpl = getTemplate(config.template);
  const patch = (p: Partial<StrategyConfig>) => onChange({ ...config, ...p });
  const setLimit = (p: Partial<AgentLimits>) => patch({ limits: { ...config.limits, ...p } });
  const setSlider = (key: string, v: number) => patch({ sliders: { ...config.sliders, [key]: v } });

  const toggleAsset = (a: string) => {
    const has = config.assets.includes(a);
    const next = has ? config.assets.filter((x) => x !== a) : [...config.assets, a];
    if (next.length > 0) patch({ assets: next });
  };

  const sources = config.insightSources;
  const agentIds = sources.flatMap((s) => (s.kind === "agent" ? [s.agentId] : []));
  const rssUrl = sources.find((s): s is Extract<InsightSource, { kind: "rss" }> => s.kind === "rss")?.url ?? null;
  const webSearch = sources.some((s) => s.kind === "web_search");
  const setSources = (next: InsightSource[]) => patch({ insightSources: next });
  const toggleAgentSource = (id: string) => {
    const next = agentIds.includes(id) ? agentIds.filter((x) => x !== id) : [...agentIds, id];
    setSources([
      ...sources.filter((s) => s.kind !== "agent"),
      ...next.map((agentId) => ({ kind: "agent" as const, agentId })),
    ]);
  };

  const [rssDraft, setRssDraft] = useState(rssUrl ?? "");
  const rssValid = /^https:\/\/.+/.test(rssDraft.trim());

  return (
    <>
      <Panel title="Identity">
        <div className="grid gap-3 p-3 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="Agent name" hint={name.trim().length < 3 ? "3-32 characters" : undefined}>
            <Input
              value={name}
              maxLength={32}
              placeholder="e.g. Momentum Mike"
              onChange={(e) => onName(e.target.value)}
              aria-label="Agent name"
            />
          </Field>
          <div className="text-[12px] text-muted">
            Template: <span className="text-text">{tpl?.name}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border px-3 py-2.5">
          <div>
            <div className="text-[12px] text-text">Run live</div>
            <div className="text-[11.5px] text-muted">
              {liveAvailable
                ? "Real Flash orders, signed by your wallet. Off means paper (simulated)."
                : "Unavailable: this server runs in paper mode (EXECUTION_MODE is not live). The agent will be paper."}
            </div>
          </div>
          <Switch label="Run live" checked={live && liveAvailable} disabled={!liveAvailable} onChange={onLive} />
        </div>
      </Panel>

      <Panel title={`Strategy · ${tpl?.name ?? ""}`}>
        <div className="grid gap-x-6 gap-y-4 p-3 md:grid-cols-2">
          {tpl?.sliders.map((s) => (
            <Slider
              key={s.key}
              label={s.label}
              unit={s.unit}
              min={s.min}
              max={s.max}
              step={s.step}
              value={config.sliders[s.key] ?? s.default}
              onChange={(v) => setSlider(s.key, v)}
            />
          ))}
        </div>
      </Panel>

      <Panel title="Markets and timing">
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-text">Assets (platform allowlist)</div>
            <div className="flex flex-wrap gap-1.5">
              {ASSET_ALLOWLIST.map((a) => {
                const on = config.assets.includes(a);
                return (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAsset(a)}
                    className={clsx(
                      "num h-7 rounded-full border px-3 text-[12px] font-medium transition-colors",
                      on ? "border-long bg-long/10 text-long" : "border-border text-muted hover:text-text",
                    )}
                  >
                    {a}
                  </button>
                );
              })}
            </div>
          </div>
          <Slider
            label="Tick interval"
            unit="s"
            min={TICK_SEC.min}
            max={TICK_SEC.max}
            step={30}
            value={config.tickIntervalSec}
            onChange={(v) => patch({ tickIntervalSec: v })}
          />
        </div>
      </Panel>

      <Panel title="Limits">
        <div className="grid gap-4 p-3 md:grid-cols-2 xl:grid-cols-3">
          <LimitInput
            label="Max notional per trade"
            value={config.limits.maxTradeUsd}
            cap={DEMO_CAPS.maxTradeUsd}
            step={0.1}
            unit="USD"
            onChange={(v) => setLimit({ maxTradeUsd: v })}
          />
          <LimitInput
            label="Max allocation"
            value={config.limits.maxAllocationUsd}
            cap={DEMO_CAPS.maxAllocationUsd}
            step={0.5}
            unit="USD"
            onChange={(v) => setLimit({ maxAllocationUsd: v })}
          />
          <LimitInput
            label="Max daily loss (pauses for the day)"
            value={config.limits.maxDailyLossUsd}
            cap={DEMO_CAPS.maxDailyLossUsd}
            step={0.1}
            unit="USD"
            onChange={(v) => setLimit({ maxDailyLossUsd: v })}
          />
          <LimitInput
            label="Max open positions"
            value={config.limits.maxOpenPositions}
            cap={DEMO_CAPS.maxOpenPositions}
            min={1}
            step={1}
            unit="#"
            onChange={(v) => setLimit({ maxOpenPositions: v })}
          />
          <LimitInput
            label="Max drawdown (auto-pauses)"
            value={config.limits.maxDrawdownPct}
            cap={100}
            step={1}
            unit="%"
            hint="Not capped by demo env"
            onChange={(v) => setLimit({ maxDrawdownPct: v })}
          />
          <LimitInput
            label="Cooldown between trades"
            value={config.limits.cooldownSec}
            cap={86_400}
            step={60}
            unit="s"
            hint="Not capped by demo env"
            onChange={(v) => setLimit({ cooldownSec: v })}
          />
        </div>
      </Panel>

      <Panel title="Models and crash protection">
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-text">Model tier</div>
            <Segmented
              value={config.modelTier}
              options={MODEL_TIERS.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(v) => patch({ modelTier: v })}
            />
            <div className="text-[11.5px] text-muted">{MODEL_TIERS.find((m) => m.value === config.modelTier)?.note}</div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-text">Crash protection (on HALT)</div>
            <Segmented
              value={config.crashMode}
              options={CRASH_MODES.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(v) => patch({ crashMode: v })}
            />
            <div className="text-[11.5px] text-muted">{CRASH_MODES.find((m) => m.value === config.crashMode)?.note}</div>
          </div>
        </div>
      </Panel>

      <Panel title="Economics and commentary">
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <Slider
            label="Commission on new profit (high-water mark)"
            unit="%"
            min={COMMISSION_BPS.min / 100}
            max={COMMISSION_BPS.max / 100}
            step={0.5}
            value={config.commissionBps / 100}
            onChange={(v) => patch({ commissionBps: Math.round(v * 100) })}
            hint="Set by CRE"
          />
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[12px] text-text">Auto-tune sliders</div>
                <div className="text-[11.5px] text-muted">Reflection may nudge sliders within the range below, once a day.</div>
              </div>
              <Switch
                label="Auto-tune"
                checked={config.autoTune.enabled}
                onChange={(v) => patch({ autoTune: { ...config.autoTune, enabled: v } })}
              />
            </div>
            {config.autoTune.enabled ? (
              <Slider
                label="Max change per slider"
                unit="%"
                min={1}
                max={25}
                step={1}
                value={config.autoTune.maxDeltaPct}
                onChange={(v) => patch({ autoTune: { ...config.autoTune, maxDeltaPct: v } })}
              />
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-text">Public commentary</div>
            <Segmented
              value={config.publicCommentary}
              options={[
                { value: "off", label: "Off" },
                { value: "delayed", label: "Delayed" },
              ]}
              onChange={(v) => patch({ publicCommentary: v })}
            />
            <div className="text-[11.5px] text-muted">Market view only: no sizes or orders.</div>
          </div>
        </div>
      </Panel>

      <Panel title="Insight sources">
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-text">Other agents&apos; public views</div>
              <span className="num text-[11px] text-muted">{agentIds.length} selected</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agents.length === 0 ? <span className="text-[12px] text-muted">No public agents yet.</span> : null}
              {agents.map((a) => {
                const on = agentIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAgentSource(a.id)}
                    className={clsx(
                      "h-7 rounded-full border px-3 text-[12px] transition-colors",
                      on ? "border-link bg-link/10 text-link" : "border-border text-muted hover:text-text",
                    )}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-text">News RSS feed</div>
              <Switch
                label="RSS feed"
                checked={rssUrl !== null}
                onChange={(on) => setSources(on ? [...sources, { kind: "rss", url: rssDraft.trim() || "https://" }] : sources.filter((s) => s.kind !== "rss"))}
              />
            </div>
            {rssUrl !== null ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="RSS URL"
                  value={rssDraft}
                  placeholder="https://example.com/feed.xml"
                  onChange={(e) => setRssDraft(e.target.value)}
                />
                <Button
                  disabled={!rssValid}
                  onClick={() => setSources([...sources.filter((s) => s.kind !== "rss"), { kind: "rss", url: rssDraft.trim() }])}
                >
                  Save
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12px] text-text">0G web search</div>
              <div className="text-[11.5px] text-muted">Recent public posts and news on allowlisted assets, via 0G tools.</div>
            </div>
            <Switch
              label="0G web search"
              checked={webSearch}
              onChange={(on) =>
                setSources(
                  on ? [...sources, { kind: "web_search" }] : sources.filter((s) => s.kind !== "web_search"),
                )
              }
            />
          </div>
        </div>
      </Panel>

      <Panel title="Fork settings">
        <div className="grid gap-4 p-3 md:grid-cols-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12px] text-text">Forkable</div>
              <div className="text-[11.5px] text-muted">Others can pay once to copy this setup into their own agent.</div>
            </div>
            <Switch
              label="Forkable"
              checked={config.fork.forkable}
              onChange={(v) => patch({ fork: { ...config.fork, forkable: v } })}
            />
          </div>
          {config.fork.forkable ? (
            <div className="flex flex-col gap-2">
              <Field
                label="Fork price (USDC)"
                hint={`Split: creator ${fmtPct(100 - FORK_PLATFORM_BPS / 100, 0)} / platform ${fmtPct(FORK_PLATFORM_BPS / 100, 0)}`}
              >
                <Input
                  type="number"
                  min={0}
                  max={FORK_PRICE_MAX_USD}
                  step={0.5}
                  value={config.fork.priceUsd}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    if (Number.isFinite(v)) patch({ fork: { ...config.fork, priceUsd: Math.min(FORK_PRICE_MAX_USD, Math.max(0, v)) } });
                  }}
                />
              </Field>
            </div>
          ) : null}
        </div>
      </Panel>
    </>
  );
}

function LimitInput({
  label,
  value,
  cap,
  min = 0,
  step,
  unit,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  cap: number;
  min?: number;
  step: number;
  unit: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={hint ?? SHARED_CAP_HINT(cap)}>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          aria-label={label}
          min={min}
          max={cap}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v)) onChange(Math.min(cap, Math.max(min, v)));
          }}
        />
        <span className="w-10 text-[11px] text-muted">{unit}</span>
      </div>
    </Field>
  );
}
