"use client";

import { useQuery } from "@tanstack/react-query";
import type { Episode, Lesson } from "@arena/shared";
import { useAccount } from "wagmi";

import { BudgetCard } from "@/components/agent/budget-card";
import { DecisionLog } from "@/components/agent/decision-log";
import { GuardrailList } from "@/components/agent/guardrail-list";
import { LessonsList } from "@/components/agent/lessons-list";
import { TreasuryCard } from "@/components/agent/treasury-card";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getJson } from "@/lib/api";
import type { AgentTreasury } from "@/lib/data";

/**
 * Owner-only console. Visible when the connected wallet is the owner, or with ?owner=1 for the demo.
 * Data is fetched only when visible. Note: this is a client-side gate; real access control needs a
 * signed-message check on the API routes.
 */
export function OwnerSection({ agentId, ownerAddress, demo }: { agentId: string; ownerAddress: string; demo: boolean }) {
  const { address, isConnected } = useAccount();
  const isOwner = demo || (isConnected && !!address && address.toLowerCase() === ownerAddress.toLowerCase());

  const episodes = useQuery({
    queryKey: ["episodes", agentId],
    queryFn: () => getJson<Episode[]>(`/api/agents/${agentId}/episodes`),
    enabled: isOwner,
  });
  const lessons = useQuery({
    queryKey: ["lessons", agentId],
    queryFn: () => getJson<Lesson[]>(`/api/agents/${agentId}/lessons`),
    enabled: isOwner,
  });
  const treasury = useQuery({
    queryKey: ["treasury", agentId],
    queryFn: () => getJson<AgentTreasury>(`/api/agents/${agentId}/treasury`),
    enabled: isOwner,
  });

  if (!isOwner) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-3 text-[12px] text-muted">
        Owner console: connect the owner wallet to see the decision log, guardrail blocks, AI budget and treasury.
      </div>
    );
  }

  const episodeList = episodes.data ?? [];
  return (
    <section className="flex flex-col gap-3" aria-label="Owner console">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-medium">Owner console</h2>
        <Badge tone="accent">Owner only</Badge>
        {demo ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="Decision log" bodyClassName="overflow-hidden">
            {episodes.isPending ? <SkeletonRows rows={5} /> : <DecisionLog episodes={episodeList} />}
          </Panel>
          <Panel title="Guardrail blocks">
            {episodes.isPending ? <SkeletonRows rows={2} /> : <GuardrailList episodes={episodeList} />}
          </Panel>
          <Panel title="Lessons · memory proof on 0G Storage">
            {lessons.isPending ? <SkeletonRows rows={3} /> : <LessonsList lessons={lessons.data ?? []} />}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="AI budget">
            {treasury.isPending ? <SkeletonRows rows={4} /> : treasury.data ? <BudgetCard zg={treasury.data.zg} /> : null}
          </Panel>
          <Panel title="Treasury">
            {treasury.isPending ? <SkeletonRows rows={4} /> : treasury.data ? <TreasuryCard treasury={treasury.data} /> : null}
          </Panel>
        </div>
      </div>
    </section>
  );
}
