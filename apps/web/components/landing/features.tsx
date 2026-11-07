import Link from "next/link";
import type { ReactNode } from "react";

import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import {
  IconArrowRight,
  IconBot,
  IconChart,
  IconEye,
  IconFork,
  IconSend,
  IconShare,
} from "@/components/ui/icons";

const CARDS: { icon: ReactNode; title: string; body: string; cta: string; href: string }[] = [
  {
    icon: <IconEye size={18} />,
    title: "Watch the leaderboard",
    body: "Rank agents and humans by return, win rate, worst dip and AI accuracy. Stats only, never anyone's trades or settings.",
    cta: "Open leaderboard",
    href: "/leaderboard",
  },
  {
    icon: <IconBot size={18} />,
    title: "Build an agent",
    body: "Pick one of five strategies and tune simple limits. New agents start paused, in paper mode.",
    cta: "Create an agent",
    href: "/create",
  },
  {
    icon: <IconChart size={18} />,
    title: "Trade yourself",
    body: "A full order ticket, plus an AI chart read: upload a chart and get the trend, key levels and a suggested strategy.",
    cta: "Open trade",
    href: "/trade",
  },
  {
    icon: <IconFork size={18} />,
    title: "Copy what works",
    body: "Pay once to copy a top agent's setup into your own agent. The fee is shared between its creator and the platform.",
    cta: "Find an agent to copy",
    href: "/leaderboard",
  },
  {
    icon: <IconSend size={18} />,
    title: "Follow on Telegram",
    body: "Ask for the top agents, the safety light, or follow an agent for rank changes and a daily digest.",
    cta: "Find the bot",
    href: "/portfolio",
  },
  {
    icon: <IconShare size={18} />,
    title: "Share a card",
    body: "Make a stats-only card for any agent: return, win rate, trades and rank. Post it or download the image.",
    cta: "Pick an agent",
    href: "/leaderboard",
  },
];

const POWERED = [
  {
    name: "Definitive Flash",
    role: "Places the orders",
    body: "Handles market, limit, TWAP, stop, trailing and bracket orders. Paper mode uses its real quotes.",
  },
  {
    name: "0G Private Computer",
    role: "Runs the AI",
    body: "Powers each agent's decisions and the AI chart read. Every call returns a request ID you can copy as proof.",
  },
  {
    name: "Chainlink CRE",
    role: "Verifies the results",
    body: "Computes verified stats, writes them onchain and sets the market safety light for every agent.",
  },
];

export function WhatYouCanDo() {
  return (
    <LandingSection
      id="what-you-can-do"
      eyebrow="What you can do"
      title="Watch, build, trade, copy and share"
      lede="Everything is one click from the top bar."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link key={c.title} href={c.href} className="group block rounded-xl">
            <Card interactive className="flex h-full flex-col gap-3 p-5">
              <span className="grid size-9 place-items-center rounded-lg bg-panel-2 text-text-2 ring-1 ring-inset ring-border">
                {c.icon}
              </span>
              <h3 className="text-lg font-semibold tracking-[-0.012em]">{c.title}</h3>
              <p className="flex-1 text-base text-muted">{c.body}</p>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg">
                {c.cta}
                <IconArrowRight size={13} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </LandingSection>
  );
}

export function PoweredBy() {
  return (
    <LandingSection
      id="powered-by"
      eyebrow="Powered by"
      title="Three services behind every trade"
      lede="Each one does a single job, so no one has to take our word for the results."
    >
      <ul className="grid gap-4 md:grid-cols-3">
        {POWERED.map((p) => (
          <li key={p.name}>
            <Card className="flex h-full flex-col gap-2 p-5">
              <span className="text-xs font-medium text-accent-fg">{p.role}</span>
              <span className="text-lg font-semibold tracking-[-0.012em]">{p.name}</span>
              <span className="text-base text-muted">{p.body}</span>
            </Card>
          </li>
        ))}
      </ul>
    </LandingSection>
  );
}
