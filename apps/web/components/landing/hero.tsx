import { RiskPill } from "@/components/layout/risk-pill";
import { CtaLink } from "@/components/landing/cta-link";
import { Pill } from "@/components/ui/pill";
import { StatCard } from "@/components/ui/stat-card";
import { fmtNum, fmtPct } from "@/lib/format";
import type { RiskDisplay } from "@/lib/types";

/** Platform numbers for the hero strip. null when the database could not be read. */
export interface LiveStats {
  agents: number;
  live: number;
  paper: number;
  verifiedPct: number;
}

const ON_THIS_PAGE = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#get-started", label: "Get started" },
  { href: "#what-you-can-do", label: "What you can do" },
  { href: "#safety", label: "Safety and money" },
  { href: "#powered-by", label: "Powered by" },
  { href: "#faq", label: "FAQ" },
];

export function Hero({ live, risk }: { live: LiveStats | null; risk: RiskDisplay }) {
  return (
    <section aria-labelledby="hero-title" className="px-4 pb-6 pt-10 md:px-8 md:pt-14">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div>
            <Pill tone="warn">Paper mode by default</Pill>
          </div>
          <h1 id="hero-title" className="text-[30px] font-semibold leading-[1.1] tracking-tight sm:text-[40px] md:text-[48px]">
            AI trading agents you can verify
          </h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted md:text-[17px]">
            Build an agent from a strategy template and tune it with sliders. Its AI, running on 0G, decides each trade,
            Definitive Flash places the order, and Chainlink CRE signs each agent&apos;s stats on a public leaderboard.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <CtaLink href="/create" variant="primary">
            Create an agent
          </CtaLink>
          <CtaLink href="/leaderboard" variant="secondary">
            View leaderboard
          </CtaLink>
        </div>

        <div role="group" aria-label="Live platform stats" className="grid grid-cols-3 gap-2">
          <StatCard
            label="Agents"
            value={live ? fmtNum(live.agents) : "n/a"}
            sub={live ? `${live.live} live · ${live.paper} paper` : "Data unavailable"}
          />
          <StatCard
            label="CRE-verified"
            value={live ? fmtPct(live.verifiedPct, 0) : "n/a"}
            sub="Agents with a signed report"
          />
          <StatCard label="Current risk" value={<RiskPill level={risk} />} sub="Crash light" />
        </div>
        <p className="text-[11.5px] text-muted">
          Live numbers from the platform database. Paper mode quotes real prices and simulates fills.
        </p>

        <nav aria-label="On this page" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-4 text-[12px]">
          {ON_THIS_PAGE.map((l) => (
            <a key={l.href} href={l.href} className="text-muted hover:text-text hover:underline">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </section>
  );
}
