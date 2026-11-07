import type { PerformanceStats } from "@arena/shared";
import { notFound } from "next/navigation";

import { AgentHeader } from "@/components/agent/agent-header";
import { AgentStatusStrip } from "@/components/agent/agent-status-strip";
import { EquityChart } from "@/components/agent/equity-chart";
import { OwnerSection } from "@/components/agent/owner-section";
import { StatsGrid } from "@/components/agent/stats-grid";
import { StrategyPanel } from "@/components/agent/strategy-panel";
import { TradesFeed } from "@/components/trades/trades-feed";
import { Container } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { getAgentEquityCurve, getLeaderboard, getPublicAgent, getTrades } from "@/lib/data";
import { getTemplate } from "@/lib/templates";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getPublicAgent(id);
  return { title: agent ? agent.name : "Agent not found" };
}

/** Zeroed stats for an agent that has no leaderboard row yet (newly created, unfunded). */
function emptyStats(id: string, name: string, template: PerformanceStats["template"], mode: PerformanceStats["mode"], selfFunded: boolean): PerformanceStats {
  return {
    entityId: id,
    kind: "agent",
    name,
    template,
    realizedPnlUsd: 0,
    realizedPnlPct: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    totalPnlPct: 0,
    volumeUsd: 0,
    trades: 0,
    winRateBps: 0,
    maxDrawdownBps: 0,
    forecastHitRateBps: 0,
    forkCount: 0,
    daysActive: 0,
    mode,
    verified: null,
    selfFunded,
  };
}

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ owner?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  // Public projection only. The full config is never rendered here; owners and licensees get it from the API.
  const agent = await getPublicAgent(id);
  if (!agent) notFound();

  const [board, equity, trades] = await Promise.all([
    getLeaderboard({ kind: "agent", timeframe: "all" }),
    getAgentEquityCurve(id),
    getTrades({ limit: 25, agentId: id }),
  ]);

  const rankIdx = board.findIndex((s) => s.entityId === id);
  const stats = rankIdx >= 0 ? board[rankIdx] : undefined;
  const resolved =
    stats ?? emptyStats(agent.id, agent.name, agent.template, agent.mode, false);
  const rank = rankIdx >= 0 ? rankIdx + 1 : null;

  const template = getTemplate(agent.template);
  const forkedFromName = agent.forkedFrom
    ? (board.find((s) => s.entityId === agent.forkedFrom)?.name ?? agent.forkedFrom)
    : null;

  return (
    <Container wide className="flex flex-col gap-6 py-8 md:py-10">
      <AgentHeader
        agent={agent}
        stats={resolved}
        templateName={template?.name ?? agent.template}
        rank={rank}
        forkedFromName={forkedFromName}
      />

      <AgentStatusStrip agentId={agent.id} demo={sp.owner === "1"} status={agent.status} />

      <StatsGrid stats={resolved} />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Panel title="Account value" description="The total value of this agent's account over time. Aggregate only.">
          <div className="p-4 pt-2">
            <EquityChart points={equity} />
          </div>
        </Panel>
        <Panel title="Strategy" description="How this agent decides.">
          {template ? <StrategyPanel template={template} /> : <div className="p-4 text-muted">Unknown strategy.</div>}
        </Panel>
      </div>

      <Panel
        title="Trades"
        description="Every fill this agent has made, newest first, each with its BaseScan link. Updates every 10 seconds."
      >
        <div className="px-4 pb-4 pt-2">
          <TradesFeed initial={trades} agentId={agent.id} limit={25} />
        </div>
      </Panel>

      <OwnerSection
        agentId={agent.id}
        status={agent.status}
        demo={sp.owner === "1"}
        mode={agent.mode}
        ownerShort={agent.ownerShort}
      />
    </Container>
  );
}
