import Link from "next/link";

import { COMMISSION_BPS } from "@/lib/templates";
import { LandingSection } from "@/components/landing/section";

interface Step {
  title: string;
  body: string;
  /** Where this step shows up in the UI. */
  shown: string;
  href?: string;
}

const STEPS: Step[] = [
  {
    title: "Pick a strategy",
    body: "Choose a template (Momentum, Mean Reversion, Breakout, Smart DCA or Social Sentiment) and set the sliders and limits.",
    shown: "Create Agent",
    href: "/create",
  },
  {
    title: "AI on 0G decides",
    body: "The agent sends current prices and its memory to a 0G Private Computer model. The reply is a forecast and a proposed order, with a 0G request ID.",
    shown: "Decision log: Forecast, Proposed, 0G request",
  },
  {
    title: "Safety rules check",
    body: "A plain code policy engine, not AI, approves, clamps or rejects each proposal. It checks allowed coins, size, daily loss and the crash light, and it attaches a take-profit and stop-loss to every buy.",
    shown: "Decision log: Verdict",
  },
  {
    title: "Flash executes",
    body: "Approved orders go to Definitive Flash. In paper mode the quote is real and the fill is simulated. In live mode the order is sent.",
    shown: "Decision log: Flash order",
  },
];

const VERIFIED = {
  title: "Verified stats and the crash light",
  body: "Chainlink CRE reads each agent's Flash fills and real prices, computes PnL and the other stats, and writes a signed report onchain. The same network sets the crash light. Agents check it before every order.",
};

const SELF_FUNDING = {
  title: "Agents pay for their own AI",
  body: "Each agent keeps a commission on new profit highs and converts it to 0G credit, which pays for its AI calls. Paper mode simulates this loop in a paper ledger.",
};

const LIGHTS = [
  { name: "NORMAL", tone: "bg-long", what: "Market calm. Agents trade normally." },
  { name: "CAUTION", tone: "bg-warn", what: "Market shaky. Half size, no new breakout buys." },
  { name: "HALT", tone: "bg-short", what: "Crash or danger. No new buys, pending entries cancelled." },
];

const LOOP = ["Trade profit", "Commission", "Treasury", "0G credit", "AI calls"];

export function HowItWorks() {
  const commissionDefault = COMMISSION_BPS.default / 100;
  const commissionMax = COMMISSION_BPS.max / 100;
  return (
    <LandingSection
      id="how-it-works"
      eyebrow="How it works"
      title="One decision, four checks, one order"
      lede="Every agent runs the same loop. Each step is visible in the owner console, and the rules are code, not promises."
    >
      <ol className="grid gap-4 md:grid-cols-4 md:gap-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative flex flex-col gap-2 rounded-md border border-border bg-panel p-4">
            <div className="flex items-center gap-2">
              <span className="num grid size-5 shrink-0 place-items-center rounded border border-border text-[11px] text-accent">
                {i + 1}
              </span>
              <h3 className="text-[13.5px] font-medium">{s.title}</h3>
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">{s.body}</p>
            <div className="mt-auto pt-1 text-[11px] text-muted">
              {s.href ? (
                <Link href={s.href} className="text-link hover:underline">
                  {s.shown} →
                </Link>
              ) : (
                <span className="num">{s.shown}</span>
              )}
            </div>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-muted md:-right-2.5 md:bottom-auto md:left-auto md:top-1/2 md:translate-x-0 md:-translate-y-1/2"
              >
                <svg viewBox="0 0 8 12" className="size-2.5 rotate-90 md:rotate-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 1l5 5-5 5" />
                </svg>
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="grid gap-3 md:grid-cols-2">
        <article className="flex flex-col gap-3 rounded-md border border-border bg-panel p-4">
          <h3 className="text-[14px] font-medium">{VERIFIED.title}</h3>
          <p className="text-[12.5px] leading-relaxed text-muted">{VERIFIED.body}</p>
          <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-bg p-3">
            {LIGHTS.map((l) => (
              <div key={l.name} className="flex items-center gap-2.5 text-[12px]">
                <dt className="flex w-[90px] shrink-0 items-center gap-1.5">
                  <span aria-hidden="true" className={`size-2 rounded-full ${l.tone}`} />
                  <span className="num font-medium">{l.name}</span>
                </dt>
                <dd className="text-muted">{l.what}</dd>
              </div>
            ))}
          </dl>
        </article>

        <article className="flex flex-col gap-3 rounded-md border border-border bg-panel p-4">
          <h3 className="text-[14px] font-medium">{SELF_FUNDING.title}</h3>
          <p className="text-[12.5px] leading-relaxed text-muted">{SELF_FUNDING.body}</p>
          <ol className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg p-3 text-[11.5px]">
            {LOOP.map((step, i) => (
              <li key={step} className="flex items-center gap-1.5">
                <span className="num rounded border border-border bg-panel-2 px-2 py-0.5">{step}</span>
                {i < LOOP.length - 1 ? (
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="text-[11.5px] text-muted">
            The owner sets the commission rate from 0% to {commissionMax}%. The default is {commissionDefault}%, and it is
            only charged on new profit highs.
          </p>
        </article>
      </div>
    </LandingSection>
  );
}
