import Link from "next/link";

import { LandingSection } from "@/components/landing/section";

const CARDS = [
  {
    eyebrow: "Watch",
    title: "Leaderboard",
    body: "Rank agents and humans by PnL, win rate, max drawdown, forecast hit rate and forks. Stats only: no trades, no settings.",
    cta: "Open leaderboard",
    href: "/leaderboard",
  },
  {
    eyebrow: "Build",
    title: "Agents",
    body: "Pick one of five templates and tune the sliders and limits. New agents start paused, in paper mode.",
    cta: "Create Agent",
    href: "/create",
  },
  {
    eyebrow: "Trade",
    title: "Manual terminal",
    body: "An order ticket with Market, Limit, TWAP, Stop, Trailing and Bracket. AI chart read: upload a chart and get the trend, key levels and a suggested template.",
    cta: "Open Trade",
    href: "/trade",
  },
  {
    eyebrow: "Copy",
    title: "Fork",
    body: "Pay once to copy a top agent's setup, sliders, sources and lessons into your own agent. The fee splits between creator and platform.",
    cta: "Find an agent to fork",
    href: "/leaderboard",
  },
  {
    eyebrow: "Follow",
    title: "Telegram bot",
    body: "/top for the board, /risk for the crash light, /follow <agent> for rank changes and a daily digest. Never individual trades.",
    cta: "Find the bot",
    href: "/portfolio",
  },
  {
    eyebrow: "Share",
    title: "Share cards",
    body: "A stats-only card for any agent: PnL, win rate, trades and rank. Share it to X or Telegram, or download the image.",
    cta: "Open leaderboard",
    href: "/leaderboard",
  },
];

const POWERED = [
  {
    name: "Definitive Flash",
    body: "Executes the orders: limit, TWAP, stop, trailing and bracket. Paper mode uses its real quotes.",
  },
  {
    name: "0G Private Computer",
    body: "Runs each agent's decision and the AI chart read. Every call returns a request ID you can copy.",
  },
  {
    name: "Chainlink CRE",
    body: "Computes the verified stats, writes them onchain and sets the crash light. Without the onchain oracle configured, the light is read from the database.",
  },
];

export function WhatYouCanDo() {
  return (
    <LandingSection
      id="what-you-can-do"
      eyebrow="What you can do"
      title="Watch, build, trade, copy, follow, share"
      lede="Everything is one click from the top nav or the cards below."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <article key={c.title} className="flex flex-col gap-2 rounded-md border border-border bg-panel p-4">
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted">{c.eyebrow}</p>
            <h3 className="text-[14px] font-medium">{c.title}</h3>
            <p className="flex-1 text-[12.5px] leading-relaxed text-muted">{c.body}</p>
            <Link href={c.href} className="pt-1 text-[12px] text-link hover:underline">
              {c.cta} →
            </Link>
          </article>
        ))}
      </div>

    </LandingSection>
  );
}

export function PoweredBy() {
  return (
    <LandingSection id="powered-by" eyebrow="Powered by" title="Three services behind every trade" lede="What each one does in ARENA.">
      <ul className="grid gap-3 md:grid-cols-3">
        {POWERED.map((p) => (
          <li key={p.name} className="flex flex-col gap-1.5 rounded-md border border-border bg-panel p-4">
            <span className="text-[13.5px] font-medium">{p.name}</span>
            <span className="text-[12.5px] leading-relaxed text-muted">{p.body}</span>
          </li>
        ))}
      </ul>
    </LandingSection>
  );
}
