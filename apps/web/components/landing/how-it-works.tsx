import Link from "next/link";
import type { ReactNode } from "react";

import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import { IconBolt, IconBrain, IconCoins, IconShield, IconSliders } from "@/components/ui/icons";
import { COMMISSION_BPS } from "@/lib/templates";

interface Step {
  icon: ReactNode;
  title: string;
  body: string;
  link?: { href: string; label: string };
}

const STEPS: Step[] = [
  {
    icon: <IconSliders size={18} />,
    title: "Pick a strategy",
    body: "Choose a style (trend following, buying dips, breakouts and more) and set simple limits. Defaults are safe.",
    link: { href: "/create", label: "Create an agent" },
  },
  {
    icon: <IconBrain size={18} />,
    title: "The AI decides",
    body: "On a schedule, your agent reads market prices and its own notes, then proposes a trade with a forecast. It runs on 0G.",
  },
  {
    icon: <IconShield size={18} />,
    title: "Safety rules check it",
    body: "Plain code, not AI, approves, shrinks or blocks every idea. It checks coins, size, daily loss and the market safety light.",
  },
  {
    icon: <IconBolt size={18} />,
    title: "The trade goes through",
    body: "Approved orders are placed through Definitive Flash. In paper mode the price is real and the fill is simulated.",
  },
];

const LIGHTS = [
  { name: "Market calm", tone: "bg-long", what: "Agents trade as usual." },
  { name: "Market shaky", tone: "bg-warn", what: "Half-size trades, no breakout buys." },
  { name: "Trading paused", tone: "bg-short", what: "No new buys, pending entries cancelled." },
];

const LOOP = ["Profit", "Small commission", "Agent's treasury", "AI credit", "More decisions"];

export function HowItWorks() {
  const commissionDefault = COMMISSION_BPS.default / 100;
  const commissionMax = COMMISSION_BPS.max / 100;
  return (
    <LandingSection
      id="how-it-works"
      eyebrow="How it works"
      title="From idea to a verified result in four steps"
      lede="Every agent follows the same loop, and you can see each step on its page."
    >
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <Card className="flex h-full flex-col gap-3 p-5">
              <div className="flex items-center justify-between">
                <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent-fg">{s.icon}</span>
                <span className="num text-sm text-subtle">0{i + 1}</span>
              </div>
              <h3 className="text-lg font-semibold tracking-[-0.012em]">{s.title}</h3>
              <p className="flex-1 text-base text-muted">{s.body}</p>
              {s.link ? (
                <Link href={s.link.href} className="text-sm font-medium text-accent-fg hover:underline">
                  {s.link.label}
                </Link>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-long-soft text-long">
              <IconShield size={18} />
            </span>
            <h3 className="text-lg font-semibold tracking-[-0.012em]">Verified results and a market safety light</h3>
          </div>
          <p className="text-base text-muted">
            Chainlink CRE reads each agent&apos;s real fills and prices, works out profit and the other stats, and signs the
            report onchain. The same network sets the safety light, which agents check before every order.
          </p>
          <dl className="flex flex-col gap-2 rounded-lg bg-panel-2 p-3">
            {LIGHTS.map((l) => (
              <div key={l.name} className="flex items-center gap-3 text-sm">
                <dt className="flex w-32 shrink-0 items-center gap-2 font-medium">
                  <span aria-hidden className={`size-2 rounded-full ${l.tone}`} />
                  {l.name}
                </dt>
                <dd className="text-muted">{l.what}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent-fg">
              <IconCoins size={18} />
            </span>
            <h3 className="text-lg font-semibold tracking-[-0.012em]">Agents pay for their own AI</h3>
          </div>
          <p className="text-base text-muted">
            An agent keeps a small commission on new profit highs and turns it into 0G credit, which pays for its AI calls.
            Paper mode simulates this loop in a practice ledger.
          </p>
          <ol className="flex flex-wrap items-center gap-1.5 rounded-lg bg-panel-2 p-3 text-sm">
            {LOOP.map((step, i) => (
              <li key={step} className="flex items-center gap-1.5">
                <span className="rounded-md bg-panel px-2 py-0.5 ring-1 ring-inset ring-border">{step}</span>
                {i < LOOP.length - 1 ? (
                  <span aria-hidden className="text-subtle">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted">
            The owner picks the commission from 0% to {commissionMax}% (default {commissionDefault}%). It is only charged on
            new highs, never on winning back old losses.
          </p>
        </Card>
      </div>
    </LandingSection>
  );
}
