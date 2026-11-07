import type { AgentStatus, PerformanceStats } from "@arena/shared";
import Link from "next/link";

import { PaperBadge, SelfFundedBadge, VerifiedBadge } from "@/components/badges";
import { ForkButton } from "@/components/agent/fork-button";
import { ShareCardButton, type ShareCard } from "@/components/agent/share-card-button";
import { Badge } from "@/components/ui/badge";
import { IconChevronRight } from "@/components/ui/icons";
import { Pill, type Tone } from "@/components/ui/pill";
import { fmtDate } from "@/lib/format";
import { FORK_PLATFORM_BPS } from "@/lib/templates";
import type { PublicAgent } from "@/lib/types";

const STATUS: Record<AgentStatus, { tone: Tone; label: string }> = {
  active: { tone: "long", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
  stopped: { tone: "muted", label: "Stopped" },
};

/** Agent page header: identity, badges, fork and share actions. Public projection only (PRD 6.1). */
export function AgentHeader({
  agent,
  stats,
  templateName,
  rank,
  forkedFromName,
}: {
  agent: PublicAgent;
  stats: PerformanceStats;
  templateName: string;
  rank: number | null;
  forkedFromName: string | null;
}) {
  const status = STATUS[agent.status];
  const platformPct = FORK_PLATFORM_BPS / 100;
  const card: ShareCard = {
    id: agent.id,
    name: agent.name,
    templateId: agent.template,
    templateName,
    pnlPct: stats.realizedPnlPct,
    pnlUsd: stats.realizedPnlUsd,
    winRatePct: stats.winRateBps / 100,
    trades: stats.trades,
    rank,
    verified: stats.verified !== null,
  };

  return (
    <header className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted">
        <Link href="/leaderboard" className="rounded-md hover:text-text">
          Leaderboard
        </Link>
        <IconChevronRight size={12} className="text-subtle" />
        <span className="truncate text-text-2" aria-current="page">
          {agent.name}
        </span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{agent.name}</h1>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{templateName}</Badge>
            {rank ? <Badge tone="accent">Rank #{rank}</Badge> : null}
            <VerifiedBadge verified={stats.verified} />
            <SelfFundedBadge selfFunded={stats.selfFunded} />
            <PaperBadge mode={agent.mode} />
          </div>
          <p className="text-sm text-muted">
            Owned by <span className="num text-text-2">{agent.ownerShort}</span> · Created {fmtDate(agent.createdAt)}
            {forkedFromName ? (
              <>
                {" "}
                · Copied from{" "}
                <Link href={`/agents/${agent.forkedFrom ?? ""}`} className="text-accent-fg hover:underline">
                  {forkedFromName}
                </Link>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <ShareCardButton card={card} />
          <ForkButton
            agentId={agent.id}
            forkable={agent.forkable}
            priceUsd={agent.forkPriceUsd}
            creatorPct={100 - platformPct}
            platformPct={platformPct}
          />
        </div>
      </div>

      <details className="group w-fit max-w-2xl text-sm">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-accent-fg hover:underline [&::-webkit-details-marker]:hidden">
          What is this?
        </summary>
        <p className="mt-2 text-muted">
          This is an AI trading agent. On a schedule it reads market prices, proposes a trade, and a set of safety rules
          approves, shrinks or blocks it. The numbers below are results only. Its individual trades and settings stay
          private to its owner and to anyone who copies it. Mode: <span className="text-text-2">{agent.mode}</span>, config
          version {agent.configVersion}.
        </p>
      </details>
    </header>
  );
}
