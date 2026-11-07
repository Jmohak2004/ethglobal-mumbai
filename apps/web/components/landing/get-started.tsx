import Link from "next/link";

import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import { IconArrowRight } from "@/components/ui/icons";

const STEPS = [
  {
    title: "Connect your wallet",
    body: "Use the button in the top right. Browsing the leaderboard and agent pages needs no wallet.",
    link: "Open portfolio",
    href: "/portfolio",
  },
  {
    title: "Sign in",
    body: "One free signature proves the wallet is yours. It is not a transaction and costs nothing.",
    link: "Open portfolio",
    href: "/portfolio",
  },
  {
    title: "Create your agent",
    body: "Pick a strategy, choose markets and risk, and review. New agents start paused, in paper mode.",
    link: "Create an agent",
    href: "/create",
  },
  {
    title: "Press Run now",
    body: "Open your agent, resume it if paused, and press Run now to see its first decision within seconds.",
    link: "Open portfolio",
    href: "/portfolio",
  },
  {
    title: "Read the decision log",
    body: "Each decision shows what the AI expected, what it proposed, whether safety rules approved it, and a proof ID.",
    link: "Open portfolio",
    href: "/portfolio",
  },
  {
    title: "Trade by hand",
    body: "Use the Trade page for market, limit, stop and more. Prices are real, and paper fills are simulated.",
    link: "Open trade",
    href: "/trade",
  },
  {
    title: "Follow on Telegram",
    body: "Send /top for the board, /risk for the safety light, or /follow with an agent name for updates.",
    link: "Find the bot",
    href: "/portfolio",
  },
  {
    title: "Copy a top agent",
    body: "On the leaderboard, open a strong agent and fork it to get its setup as a paper agent of your own.",
    link: "Open leaderboard",
    href: "/leaderboard",
  },
];

export function GetStarted() {
  return (
    <LandingSection
      id="get-started"
      eyebrow="Get started"
      title="Your first agent, step by step"
      lede="Paper mode needs no funds. Do them in order, or stop after step 1 and just watch."
    >
      <Card className="overflow-hidden">
        <ol className="grid md:grid-cols-2">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="flex gap-4 border-b border-border p-5 last:border-b-0 md:[&:nth-last-child(2)]:border-b-0 md:odd:border-r"
            >
              <span className="num mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs text-muted ring-1 ring-inset ring-border">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-base font-semibold">{s.title}</h3>
                <p className="text-sm text-muted">{s.body}</p>
                <Link href={s.href} className="mt-1 inline-flex w-fit items-center gap-1 text-sm font-medium text-accent-fg hover:underline">
                  {s.link} <IconArrowRight size={13} />
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </LandingSection>
  );
}
