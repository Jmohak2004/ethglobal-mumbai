import { LandingSection } from "@/components/landing/section";
import { COMMISSION_BPS, DEMO_CAPS } from "@/lib/templates";

const POINTS = [
  {
    title: "Paper mode by default",
    body: "Agents and manual trades get real Flash quotes and simulated fills. Nothing is sent to Flash and no money moves. The order ticket says Paper · simulated.",
  },
  {
    title: "Tiny caps",
    body: "Every agent has hard limits, and owners can set them lower, not higher. The per-trade cap is what you see in the Limits panel on Create Agent.",
  },
  {
    title: "Take-profit and stop-loss on every buy",
    body: "Each buy carries a take-profit and a stop-loss, priced from the mark. Paper mode monitors both in simulation.",
  },
  {
    title: "The crash light",
    body: "NORMAL, CAUTION or HALT. On HALT an agent opens no new buys and cancels pending entries. Then, per the owner's setting, it tightens stop-losses or sells everything to USDC.",
  },
  {
    title: "Stats-only privacy",
    body: "The leaderboard shows stats, not trades, sliders or configs. Owners and forkers see the full setup.",
  },
  {
    title: "Commission only on new highs",
    body: "Commission is charged only on profit above the agent's high-water mark, never on winning back old losses.",
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
      value: `${COMMISSION_BPS.min / 100}–${COMMISSION_BPS.max / 100}%`,
      note: `default ${COMMISSION_BPS.default / 100}%, new highs only`,
    },
  ];

  return (
    <LandingSection
      id="safety"
      eyebrow="Safety and money"
      title="Small by design, paper first"
      lede="The limits are code the agent cannot talk its way past. The numbers on the right are the server's upper bounds."
    >
      <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-panel">
          {POINTS.map((p) => (
            <li key={p.title} className="flex flex-col gap-1 px-4 py-3">
              <h3 className="text-[13px] font-medium">{p.title}</h3>
              <p className="text-[12.5px] leading-relaxed text-muted">{p.body}</p>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-3">
          <section aria-labelledby="limits-title" className="flex flex-col rounded-md border border-border bg-panel">
            <h3
              id="limits-title"
              className="flex h-8 items-center border-b border-border px-3 text-[10.5px] font-medium uppercase tracking-wider text-muted"
            >
              Limits per agent
            </h3>
            <dl>
              {caps.map((c) => (
                <div key={c.label} className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <dt className="text-[12.5px]">
                    {c.label}
                    {c.note ? <span className="block text-[11px] text-muted">{c.note}</span> : null}
                  </dt>
                  <dd className="num text-[13px] font-medium">{c.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <p className="text-[11.5px] leading-relaxed text-muted">
            Servers with DEMO_CONTROLS on show a Demo menu in the nav that can simulate a HALT for testing. It is off by default.
          </p>
        </div>
      </div>
    </LandingSection>
  );
}
