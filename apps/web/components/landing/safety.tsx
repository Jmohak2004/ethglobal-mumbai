import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import { IconCheck } from "@/components/ui/icons";
import { COMMISSION_BPS, DEMO_CAPS } from "@/lib/templates";

const POINTS = [
  {
    title: "Paper mode by default",
    body: "Agents and manual trades get real prices and simulated fills. Nothing is sent and no money moves.",
  },
  {
    title: "Tiny, hard limits",
    body: "Every agent has caps on trade size, daily loss and open positions. Owners can lower them, never raise them.",
  },
  {
    title: "Take-profit and stop-loss on every buy",
    body: "Each buy is paired with an exit for gains and an exit for losses, set from the current price.",
  },
  {
    title: "A crash light agents obey",
    body: "When the market looks dangerous, agents stop opening new buys and cancel pending ones, then tighten stops or sell to USDC.",
  },
  {
    title: "Stats-only privacy",
    body: "The leaderboard shows results, not trades, settings or sliders. Only owners and people who copy an agent see its setup.",
  },
  {
    title: "Commission only on new highs",
    body: "Agents earn commission only on profit above their previous best, never on winning back old losses.",
  },
];

export function Safety() {
  const caps: { label: string; value: string; note?: string }[] = [
    { label: "Max per trade", value: `$${DEMO_CAPS.maxTradeUsd}` },
    { label: "Max allocation", value: `$${DEMO_CAPS.maxAllocationUsd}` },
    { label: "Max daily loss", value: `$${DEMO_CAPS.maxDailyLossUsd}`, note: "pauses the agent for the day" },
    { label: "Max open positions", value: String(DEMO_CAPS.maxOpenPositions) },
    {
      label: "Commission",
      value: `${COMMISSION_BPS.min / 100} to ${COMMISSION_BPS.max / 100}%`,
      note: `default ${COMMISSION_BPS.default / 100}%, new highs only`,
    },
  ];

  return (
    <LandingSection
      id="safety"
      eyebrow="Safety and money"
      title="Small by design, paper first"
      lede="The limits are code that an agent cannot talk its way past."
    >
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <ul className="grid sm:grid-cols-2">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3 border-b border-border p-5 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0 sm:odd:border-r">
                <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-long-soft text-long">
                  <IconCheck size={12} strokeWidth={2.5} />
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-semibold">{p.title}</h3>
                  <p className="text-sm text-muted">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="self-start">
          <h3 className="border-b border-border px-5 py-3.5 text-base font-semibold">Limits per agent</h3>
          <dl>
            {caps.map((c) => (
              <div key={c.label} className="flex items-baseline justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0">
                <dt className="text-base">
                  {c.label}
                  {c.note ? <span className="block text-xs text-muted">{c.note}</span> : null}
                </dt>
                <dd className="num text-base font-medium">{c.value}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-border bg-panel-2/60 px-5 py-3 text-xs text-muted">
            These are the server&apos;s upper bounds in this build.
          </p>
        </Card>
      </div>
    </LandingSection>
  );
}
