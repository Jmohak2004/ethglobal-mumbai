import type { Agent, PerformanceStats } from "@arena/shared";
import Link from "next/link";

import { PaperBadge, SelfFundedBadge, VerifiedBadge } from "@/components/badges";
import { ForkButton } from "@/components/agent/fork-button";
import { ShareCardButton, type ShareCard } from "@/components/agent/share-card-button";
import { Badge } from "@/components/ui/badge";
import { Pill, type Tone } from "@/components/ui/pill";
import { fmtDate, fmtPct, shortAddr } from "@/lib/format";
import { FORK_PLATFORM_BPS } from "@/lib/templates";

const STATUS: Record<Agent["status"], { tone: Tone; label: string }> = {
  active: { tone: "long", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
  stopped: { tone: "muted", label: "Stopped" },
};

/** Agent page header: identity, badges, fork and share actions. */
export function AgentHeader({
  agent,
  stats,
  templateName,
  rank,
  forkedFromName,
}: {
  agent: Agent;
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
    templateId: agent.config.template,
    templateName,
    pnlPct: stats.realizedPnlPct,
    pnlUsd: stats.realizedPnlUsd,
    winRatePct: stats.winRateBps / 100,
    trades: stats.trades,
    rank,
    verified: stats.verified !== null,
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="text-[11.5px] text-muted">
          <Link href="/" className="hover:text-text">
            Leaderboard
          </Link>
          <span className="px-1.5">/</span>
          <span>{agent.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[18px] font-semibold tracking-tight">{agent.name}</h1>
          <Badge tone="neutral">{templateName}</Badge>
          <Pill tone={status.tone}>{status.label}</Pill>
          <VerifiedBadge verified={stats.verified} />
          <SelfFundedBadge selfFunded={stats.selfFunded} />
          <PaperBadge mode={agent.mode} />
        </div>
        <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <span>Owner {shortAddr(agent.ownerAddress)}</span>
          <span>Created {fmtDate(agent.createdAt)}</span>
          <span>Config v{agent.configVersion}</span>
          <span>Mode {agent.mode}</span>
          {forkedFromName ? (
            <span>
              Forked from{" "}
              <Link href={`/agents/${agent.forkedFrom ?? ""}`} className="text-link hover:underline">
                {forkedFromName}
              </Link>
            </span>
          ) : null}
          <span className={stats.realizedPnlPct >= 0 ? "text-long" : "text-short"}>
            All-time {fmtPct(stats.realizedPnlPct, 2, true)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <ShareCardButton card={card} />
        <ForkButton
          agentId={agent.id}
          forkable={agent.config.fork.forkable}
          priceUsd={agent.config.fork.priceUsd}
          creatorPct={100 - platformPct}
          platformPct={platformPct}
        />
      </div>
    </div>
  );
}
