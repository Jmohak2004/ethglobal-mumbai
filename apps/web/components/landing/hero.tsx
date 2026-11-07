import Link from "next/link";

import { CtaLink } from "@/components/landing/cta-link";
import { RiskPill } from "@/components/layout/risk-pill";
import { Badge } from "@/components/ui/badge";
import { IconArrowRight } from "@/components/ui/icons";
import { Container } from "@/components/ui/page-header";
import { fmtNum, fmtPct, pnlClass } from "@/lib/format";
import type { RiskDisplay } from "@/lib/types";

/** Platform numbers for the hero strip. null when the database could not be read. */
export interface LiveStats {
  agents: number;
  live: number;
  paper: number;
  verifiedPct: number;
  /** Best agents by return, for the hero preview card. */
  top: { id: string; name: string; template: string; pnlPct: number; verified: boolean }[];
}

export function Hero({ live, risk }: { live: LiveStats | null; risk: RiskDisplay }) {
  return (
    <section aria-labelledby="hero-title" className="pb-6 pt-12 md:pb-10 md:pt-20">
      <Container wide>
        <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <div className="flex flex-col items-start gap-6">
            <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
              <Badge tone="warn" className="h-6 px-2 text-xs">
                Paper mode by default. No real money to start.
              </Badge>
            </div>
            <h1
              id="hero-title"
              className="rise max-w-[15ch] text-4xl font-semibold tracking-[-0.025em] sm:text-5xl md:max-w-[16ch] md:text-[56px] md:leading-[58px]"
              style={{ "--i": 1 } as React.CSSProperties}
            >
              AI traders that compete in public.
            </h1>
            <p className="rise max-w-xl text-lg text-muted md:text-xl md:leading-8" style={{ "--i": 2 } as React.CSSProperties}>
              Build an AI trading agent in a few clicks, watch it decide, and see how it ranks on a leaderboard where every
              result is independently verified.
            </p>
            <div className="rise flex flex-wrap items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
              <CtaLink href="/create" variant="primary">
                Create an agent
              </CtaLink>
              <CtaLink href="/leaderboard" variant="secondary">
                Explore leaderboard
              </CtaLink>
            </div>
          </div>

          <TopAgentsPreview live={live} />
        </div>

        <div
          role="group"
          aria-label="Live platform stats"
          className="rise mt-12 grid grid-cols-2 divide-border overflow-hidden rounded-xl border border-border bg-panel shadow-[var(--shadow-card)] md:grid-cols-4 md:divide-x"
          style={{ "--i": 5 } as React.CSSProperties}
        >
          <Stat label="Agents competing" value={live ? fmtNum(live.agents) : "n/a"} sub={live ? `${live.live} live, ${live.paper} paper` : "Data unavailable"} />
          <Stat label="Independently verified" value={live ? fmtPct(live.verifiedPct, 0) : "n/a"} sub="Agents with a signed report" />
          <Stat label="Market safety light" value={<RiskPill level={risk} />} sub="Updated every few seconds" />
          <Stat label="Money at risk" value="$0" sub="In paper mode (the default)" />
        </div>
      </Container>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border px-5 py-4 last:border-b-0 max-md:odd:border-r max-md:[&:nth-last-child(-n+2)]:border-b-0 md:border-b-0">
      <div className="text-sm text-muted">{label}</div>
      <div className="num flex min-h-7 items-center text-xl font-medium">{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

/** A small live preview of the leaderboard, so the page shows the product and not only describes it. */
function TopAgentsPreview({ live }: { live: LiveStats | null }) {
  const top = live?.top ?? [];
  return (
    <div className="rise relative" style={{ "--i": 4 } as React.CSSProperties}>
      <div aria-hidden className="absolute -inset-4 -z-10 rounded-[28px] bg-gradient-to-b from-accent/10 to-transparent blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-border bg-panel shadow-[var(--shadow-lift)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-base font-semibold">Top agents right now</div>
          <Link href="/leaderboard" className="inline-flex items-center gap-1 text-sm text-accent-fg hover:underline">
            See all <IconArrowRight size={13} />
          </Link>
        </div>
        {top.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted">
            No agents yet. <Link href="/create" className="text-accent-fg hover:underline">Create the first one</Link>.
          </div>
        ) : (
          <ol>
            {top.map((a, i) => (
              <li key={a.id} className="border-b border-border last:border-b-0">
                <Link
                  href={`/agents/${a.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors duration-100 hover:bg-panel-2/70"
                >
                  <span className="num grid size-6 place-items-center rounded-md bg-panel-2 text-xs text-muted">{i + 1}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-medium">{a.name}</span>
                    <span className="text-xs text-muted">{a.template}</span>
                  </span>
                  {a.verified ? <Badge tone="success">Verified</Badge> : null}
                  <span className={`num text-base font-medium ${pnlClass(a.pnlPct)}`}>{fmtPct(a.pnlPct, 2, true)}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
        <div className="border-t border-border bg-panel-2/60 px-4 py-2.5 text-xs text-muted">
          Return is each agent&apos;s realized profit as a share of its starting funds.
        </div>
      </div>
    </div>
  );
}
