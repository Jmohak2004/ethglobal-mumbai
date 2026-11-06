import type { PerformanceStats } from "@arena/shared";
import { notFound } from "next/navigation";

import { AgentHeader } from "@/components/agent/agent-header";
import { EquityChart } from "@/components/agent/equity-chart";
import { OwnerSection } from "@/components/agent/owner-section";
import { StatsGrid } from "@/components/agent/stats-grid";
import { StrategyPanel } from "@/components/agent/strategy-panel";
import { Panel } from "@/components/ui/panel";
import { getAgent, getAgentEquityCurve, getLeaderboard } from "@/lib/data";
import { getTemplate } from "@/lib/templates";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getAgent(id);
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
  const agent = await getAgent(id);
  if (!agent) notFound();

  const [board, equity] = await Promise.all([
    getLeaderboard({ kind: "agent", timeframe: "all" }),
    getAgentEquityCurve(id),
  ]);

  const rankIdx = board.findIndex((s) => s.entityId === id);
  const stats = rankIdx >= 0 ? board[rankIdx] : undefined;
  const resolved =
    stats ?? emptyStats(agent.id, agent.name, agent.config.template, agent.mode, false);
  const rank = rankIdx >= 0 ? rankIdx + 1 : null;

  const template = getTemplate(agent.config.template);
  const forkedFromName = agent.forkedFrom
    ? (board.find((s) => s.entityId === agent.forkedFrom)?.name ?? agent.forkedFrom)
    : null;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <AgentHeader
        agent={agent}
        stats={resolved}
        templateName={template?.name ?? agent.config.template}
        rank={rank}
        forkedFromName={forkedFromName}
      />

      <StatsGrid stats={resolved} />

      <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
        <Panel title="Aggregate equity">
          <div className="p-3">
            <EquityChart points={equity} />
          </div>
        </Panel>
        <Panel title="Strategy">
          {template ? <StrategyPanel template={template} /> : <div className="p-3 text-muted">Unknown template.</div>}
        </Panel>
      </div>

      <OwnerSection agentId={agent.id} ownerAddress={agent.ownerAddress} demo={sp.owner === "1"} />
    </div>
  );
}
