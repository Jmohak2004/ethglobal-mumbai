"use client";

import { clsx } from "clsx";
import type { AgentLimits, InsightSource, StrategyConfig } from "@arena/shared";
import { useState, type ReactNode } from "react";

import type { AgentOption } from "@/components/create/create-wizard";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { fmtPct } from "@/lib/format";
import {
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
  name?: string;
  onName?: (n: string) => void;
  agents?: AgentOption[];
  live?: boolean;
  onLive?: (v: boolean) => void;
  /** False when the server is not in EXECUTION_MODE=live. The agent is then created in paper mode. */
  liveAvailable?: boolean;
  /** Platform asset allowlist (ALLOWED_TOKENS), one chip each. */
  assets?: readonly string[];
}

/** Plain-language help for every slider. Unknown keys fall back to no help rather than a wrong one. */
const SLIDER_HELP: Record<string, string> = {
  minConfidence: "How sure the AI must be before it trades. Higher means fewer, pickier trades.",
  sizePct: "How much of the agent's funds each trade uses. Smaller is gentler.",
  takeProfitPct: "Sell to lock in a gain once the price has risen this much.",
  stopLossPct: "Sell to cap a loss once the price has fallen this much.",
  lookbackBars: "How far back the agent looks to spot a trend. Longer means slower, steadier signals.",
  trailPct: "A stop-loss that follows the price up, so gains are protected as they grow.",
  rsiLow: "Below this reading the asset looks oversold, which the agent treats as a buying chance.",
  rsiHigh: "Above this reading the asset looks overbought, which the agent treats as a selling chance.",
  maxHoldMin: "The longest the agent keeps a position open before closing it.",
  rangeBars: "How many recent candles define the price range it watches for a breakout.",
  breakoutPct: "How far past the range the price must move to count as a real breakout.",
  budgetUsd: "How much the agent spends in each buying period.",
  periodMin: "How often the agent makes a regular purchase.",
  buckets: "How many small pieces the buying budget is split into.",
  dipMultiplierMax: "On a price dip the agent can buy up to this many times more than usual.",
  stopLossFloorPct: "The deepest loss the agent will accept before it sells.",
  minSourceAgreement: "How much its news and other-agent sources must agree before it acts.",
};

/** Sliders every strategy shares. These live in the main "risk" step; the rest are strategy tuning under Advanced. */
const BASIC_SLIDERS = ["sizePct", "takeProfitPct", "stopLossPct", "minConfidence"];

function useHelpers({ config, onChange }: Pick<ConfigFormProps, "config" | "onChange">) {
  const patch = (p: Partial<StrategyConfig>) => onChange({ ...config, ...p });
  return {
    patch,
    setLimit: (p: Partial<AgentLimits>) => patch({ limits: { ...config.limits, ...p } }),
    setSlider: (key: string, v: number) => patch({ sliders: { ...config.sliders, [key]: v } }),
  };
}

/** Step 2: name, markets and the handful of risk controls most people care about. */
export function ConfigBasics({ config, onChange, name = "", onName, assets = [] }: ConfigFormProps) {
  const tpl = getTemplate(config.template);
  const { patch, setLimit, setSlider } = useHelpers({ config, onChange });

  const toggleAsset = (a: string) => {
    const has = config.assets.includes(a);
    const next = has ? config.assets.filter((x) => x !== a) : [...config.assets, a];
    if (next.length > 0) patch({ assets: next });
  };

  const basics = tpl?.sliders.filter((s) => BASIC_SLIDERS.includes(s.key)) ?? [];

  return (
    <div className="flex flex-col gap-8">
      <Block title="Name your agent" description="Pick something memorable. It shows on the leaderboard.">
        <div className="max-w-sm">
          <Field label="Agent name" hint={name.trim().length < 3 ? "3 to 32 characters" : undefined}>
            <Input
              value={name}
              maxLength={32}
              placeholder="e.g. Momentum Mike"
              onChange={(e) => onName?.(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
      </Block>

      <Block title="Which markets can it trade?" description="Pick at least one. Fewer markets means a more focused agent.">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Markets">
          {assets.map((a) => {
            const on = config.assets.includes(a);
            return (
              <button
                key={a}
                type="button"
                aria-pressed={on}
                onClick={() => toggleAsset(a)}
                className={clsx(
                  "num h-8 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.97]",
                  on
                    ? "border-accent bg-accent-soft text-accent-fg"
                    : "border-border-strong bg-panel text-muted hover:border-subtle hover:text-text",
                )}
              >
                {a}
              </button>
            );
          })}
        </div>
      </Block>

      <Block title="How much risk?" description="The defaults are sensible for a first agent. Change them only if you know what you want.">
        <div className="grid gap-x-8 gap-y-7 md:grid-cols-2">
          {basics.map((s) => (
            <Slider
              key={s.key}
              label={s.label}
              unit={s.unit}
              min={s.min}
              max={s.max}
              step={s.step}
              value={config.sliders[s.key] ?? s.default}
              onChange={(v) => setSlider(s.key, v)}
              help={SLIDER_HELP[s.key]}
            />
          ))}
          <LimitInput
            label="Most it can spend per trade"
            value={config.limits.maxTradeUsd}
            cap={DEMO_CAPS.maxTradeUsd}
            step={0.1}
            unit="USD"
            help="A hard ceiling on the size of any one trade."
            onChange={(v) => setLimit({ maxTradeUsd: v })}
          />
          <LimitInput
            label="Most it can lose in a day"
            value={config.limits.maxDailyLossUsd}
            cap={DEMO_CAPS.maxDailyLossUsd}
            step={0.1}
            unit="USD"
            help="If it loses this much in a day, it stops until tomorrow."
            onChange={(v) => setLimit({ maxDailyLossUsd: v })}
          />
        </div>
      </Block>
    </div>
  );
}

/** Everything else, tucked under "Advanced settings". Safe to ignore: defaults apply. */
export function ConfigAdvanced({ config, onChange, agents = [], live = false, onLive, liveAvailable = false }: ConfigFormProps) {
  const tpl = getTemplate(config.template);
  const { patch, setLimit, setSlider } = useHelpers({ config, onChange });

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
  const tuning = tpl?.sliders.filter((s) => !BASIC_SLIDERS.includes(s.key)) ?? [];

  return (
    <div className="flex flex-col divide-y divide-border">
      {tuning.length > 0 ? (
        <AdvBlock title={`${tpl?.name ?? "Strategy"} tuning`} description="Settings specific to this strategy.">
          <div className="grid gap-x-8 gap-y-7 md:grid-cols-2">
            {tuning.map((s) => (
              <Slider
                key={s.key}
                label={s.label}
                unit={s.unit}
                min={s.min}
                max={s.max}
                step={s.step}
                value={config.sliders[s.key] ?? s.default}
                onChange={(v) => setSlider(s.key, v)}
                help={SLIDER_HELP[s.key]}
              />
            ))}
          </div>
        </AdvBlock>
      ) : null}

      <AdvBlock title="More limits" description="Extra guardrails. Limits can be lowered, never raised past the platform caps.">
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          <LimitInput
            label="Max total funds"
            value={config.limits.maxAllocationUsd}
            cap={DEMO_CAPS.maxAllocationUsd}
            step={0.5}
            unit="USD"
            help="The most money the agent can hold at once."
            onChange={(v) => setLimit({ maxAllocationUsd: v })}
          />
          <LimitInput
            label="Max open positions"
            value={config.limits.maxOpenPositions}
            cap={DEMO_CAPS.maxOpenPositions}
            min={1}
            step={1}
            unit="#"
            help="How many trades it can have open at the same time."
            onChange={(v) => setLimit({ maxOpenPositions: v })}
          />
          <LimitInput
            label="Pause if it falls from its peak by"
            value={config.limits.maxDrawdownPct}
            cap={100}
            step={1}
            unit="%"
            help="Automatically pauses the agent after this big a drop from its best value."
            onChange={(v) => setLimit({ maxDrawdownPct: v })}
          />
          <LimitInput
            label="Wait between trades"
            value={config.limits.cooldownSec}
            cap={86_400}
            step={60}
            unit="sec"
            help="A cool-off period after each trade."
            onChange={(v) => setLimit({ cooldownSec: v })}
          />
        </div>
      </AdvBlock>

      <AdvBlock title="Timing and AI model">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <Slider
            label="Decide every"
            unit="s"
            min={TICK_SEC.min}
            max={TICK_SEC.max}
            step={30}
            value={config.tickIntervalSec}
            onChange={(v) => patch({ tickIntervalSec: v })}
            help="How often the agent looks at the market and decides. More often uses more AI credit."
          />
          <OptionRow label="AI model" note={MODEL_TIERS.find((m) => m.value === config.modelTier)?.note}>
            <Segmented
              label="AI model"
              value={config.modelTier}
              options={MODEL_TIERS.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(v) => patch({ modelTier: v })}
            />
          </OptionRow>
          <OptionRow label="If the market crashes" note={CRASH_MODES.find((m) => m.value === config.crashMode)?.note}>
            <Segmented
              label="If the market crashes"
              value={config.crashMode}
              options={CRASH_MODES.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(v) => patch({ crashMode: v })}
            />
          </OptionRow>
        </div>
      </AdvBlock>

      <AdvBlock title="Earnings and learning">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <Slider
            label="Commission on new profit highs"
            unit="%"
            min={COMMISSION_BPS.min / 100}
            max={COMMISSION_BPS.max / 100}
            step={0.5}
            value={config.commissionBps / 100}
            onChange={(v) => patch({ commissionBps: Math.round(v * 100) })}
            hint="Set by CRE"
            help="The agent keeps this share of new profit to pay for its own AI. Never charged on recovering old losses."
          />
          <div className="flex flex-col gap-4">
            <SwitchRow
              label="Auto-tune settings"
              note="Once a day the agent may nudge its sliders within the limit below, based on what it learned."
              checked={config.autoTune.enabled}
              onChange={(v) => patch({ autoTune: { ...config.autoTune, enabled: v } })}
            />
            {config.autoTune.enabled ? (
              <Slider
                label="Biggest change per slider"
                unit="%"
                min={1}
                max={25}
                step={1}
                value={config.autoTune.maxDeltaPct}
                onChange={(v) => patch({ autoTune: { ...config.autoTune, maxDeltaPct: v } })}
              />
            ) : null}
          </div>
          <OptionRow label="Public commentary" note="A short market view anyone can read. Never includes sizes or orders.">
            <Segmented
              label="Public commentary"
              value={config.publicCommentary}
              options={[
                { value: "off", label: "Off" },
                { value: "delayed", label: "Delayed" },
              ]}
              onChange={(v) => patch({ publicCommentary: v })}
            />
          </OptionRow>
        </div>
      </AdvBlock>

      <AdvBlock title="Extra information sources" description="Optional extra inputs the AI can read before deciding.">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Other agents&apos; public views</div>
              <span className="num text-xs text-muted">{agentIds.length} selected</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {agents.length === 0 ? <span className="text-sm text-muted">No public agents yet.</span> : null}
              {agents.map((a) => {
                const on = agentIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAgentSource(a.id)}
                    className={clsx(
                      "h-8 rounded-full border px-3.5 text-sm transition-[background-color,border-color,color] duration-150",
                      on ? "border-accent bg-accent-soft text-accent-fg" : "border-border-strong text-muted hover:text-text",
                    )}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SwitchRow
              label="News feed (RSS)"
              note="Read headlines from a feed you choose."
              checked={rssUrl !== null}
              onChange={(on) =>
                setSources(on ? [...sources, { kind: "rss", url: rssDraft.trim() || "https://" }] : sources.filter((s) => s.kind !== "rss"))
              }
            />
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

          <SwitchRow
            label="Web search (0G)"
            note="Recent public posts and news about the markets it trades."
            checked={webSearch}
            onChange={(on) => setSources(on ? [...sources, { kind: "web_search" }] : sources.filter((s) => s.kind !== "web_search"))}
          />
        </div>
      </AdvBlock>

      <AdvBlock title="Let others copy this agent" description="Forking lets people pay once to copy your setup.">
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          <SwitchRow
            label="Allow forking"
            note="Others can pay once to copy this setup into their own agent."
            checked={config.fork.forkable}
            onChange={(v) => patch({ fork: { ...config.fork, forkable: v } })}
          />
          {config.fork.forkable ? (
            <Field
              label="Price to copy (USDC)"
              hint={`You keep ${fmtPct(100 - FORK_PLATFORM_BPS / 100, 0)}, the platform keeps ${fmtPct(FORK_PLATFORM_BPS / 100, 0)}.`}
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
          ) : null}
        </div>
      </AdvBlock>

      {onLive ? (
        <AdvBlock title="Trading mode">
          <SwitchRow
            label="Trade with real money (live)"
            note={
              liveAvailable
                ? "Real orders, signed by your wallet. Off means paper: real prices, simulated trades."
                : "Not available: this server runs in paper mode, so your agent will be paper."
            }
            checked={live && liveAvailable}
            disabled={!liveAvailable}
            onChange={onLive}
          />
        </AdvBlock>
      ) : null}
    </div>
  );
}

function Block({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold tracking-[-0.012em]">{title}</h3>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function AdvBlock({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 p-5">
      <div>
        <h4 className="text-base font-semibold">{title}</h4>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function OptionRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </div>
  );
}

function SwitchRow({
  label,
  note,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {note ? <p className="text-xs text-muted">{note}</p> : null}
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function LimitInput({
  label,
  value,
  cap,
  min = 0,
  step,
  unit,
  help,
  onChange,
}: {
  label: string;
  value: number;
  cap: number;
  min?: number;
  step: number;
  unit: string;
  help?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={`${help ? `${help} ` : ""}Max ${cap} ${unit}.`}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={min}
          max={cap}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v)) onChange(Math.min(cap, Math.max(min, v)));
          }}
        />
        <span className="w-10 text-xs text-muted">{unit}</span>
      </div>
    </Field>
  );
}
