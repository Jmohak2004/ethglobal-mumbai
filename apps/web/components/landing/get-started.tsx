import Link from "next/link";

import { LandingSection } from "@/components/landing/section";

const STEPS = [
  {
    title: "Connect Wallet",
    body: "Click Connect Wallet in the top right. The leaderboard and agent pages need no wallet.",
    link: "Open Portfolio",
    href: "/portfolio",
  },
  {
    title: "Sign in",
    body: "Click Sign in with your wallet. It is a free signature, not a transaction.",
    link: "Open Portfolio",
    href: "/portfolio",
  },
  {
    title: "Create Agent",
    body: "Choose a template, set the sliders and limits, then click Create agent. The agent starts paused, in paper mode.",
    link: "Create an agent",
    href: "/create",
  },
  {
    title: "Run now",
    body: "Open your agent from Portfolio. Resume it if it is paused, then press Run now. The button reads queued… until the worker picks it up.",
    link: "Open Portfolio",
    href: "/portfolio",
  },
  {
    title: "Read the decision log",
    body: "In the owner console, check Forecast, Proposed, Verdict and the 0G request. Copy the 0G request ID as proof of the AI call.",
    link: "Open Portfolio",
    href: "/portfolio",
  },
  {
    title: "Trade manually",
    body: "On Trade, pick Market, Limit, TWAP, Stop, Trailing or Bracket. Quotes are real. In paper mode the fill is simulated.",
    link: "Open Trade",
    href: "/trade",
  },
  {
    title: "Follow agents on Telegram",
    body: "Find the bot on Portfolio. Send /top for the board, /risk for the crash light, or /follow <agent> for updates.",
    link: "Open Portfolio",
    href: "/portfolio",
  },
  {
    title: "Fork a top agent",
    body: "On the leaderboard, open a top agent and press Fork · $X USDC to copy its setup into a paper agent of your own.",
    link: "Open leaderboard",
    href: "/leaderboard",
  },
];

export function GetStarted() {
  return (
    <LandingSection
      id="get-started"
      eyebrow="Get started"
      title="Your first agent in eight steps"
      lede="Paper mode needs no funds. Follow these in order, or stop after step 1 to just watch the leaderboard."
    >
      <ol className="grid gap-x-6 md:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3 border-t border-border py-3">
            <span className="num w-5 shrink-0 pt-0.5 text-[12px] text-accent">{String(i + 1).padStart(2, "0")}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="text-[13.5px] font-medium">{s.title}</h3>
              <p className="text-[12.5px] leading-relaxed text-muted">{s.body}</p>
              <Link href={s.href} className="text-[12px] text-link hover:underline">
                {s.link} →
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </LandingSection>
  );
}
