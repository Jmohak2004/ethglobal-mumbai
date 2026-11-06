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
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ApiClientError, getJson } from "@/lib/api";
import { useSession } from "@/lib/hooks/use-session";
import type { AgentTreasury } from "@/lib/types";

/**
 * Owner-only console. Shown when the server session is the agent owner (signed once with the owner wallet), or
 * with ?owner=1 for the demo outside production. The API enforces the same rule; this only decides what to render.
 */
export function OwnerSection({ agentId, ownerAddress, demo }: { agentId: string; ownerAddress: string; demo: boolean }) {
  const owner = ownerAddress.toLowerCase();
  const { address } = useAccount();
  const connectedIsOwner = !!address && address.toLowerCase() === owner;
  const session = useSession({ prompt: connectedIsOwner });
  const isOwner = demo || session.signedAddress === owner;
  const q = demo ? "?owner=1" : "";

  const episodes = useQuery({
    queryKey: ["episodes", agentId, demo],
    queryFn: () => getJson<Episode[]>(`/api/agents/${agentId}/episodes${q}`),
    enabled: isOwner,
    retry: false,
  });
  const lessons = useQuery({
    queryKey: ["lessons", agentId, demo],
    queryFn: () => getJson<Lesson[]>(`/api/agents/${agentId}/lessons${q}`),
    enabled: isOwner,
    retry: false,
  });
  const treasury = useQuery({
    queryKey: ["treasury", agentId, demo],
    queryFn: () => getJson<AgentTreasury>(`/api/agents/${agentId}/treasury${q}`),
    enabled: isOwner,
    retry: false,
  });

  if (!isOwner) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 text-[12px] text-muted">
        <span>Owner console: connect the owner wallet and sign in to see the decision log, guardrail blocks, AI budget and treasury.</span>
        {connectedIsOwner && session.ready ? (
          <Button
            variant="secondary"
            onClick={() => session.signIn().catch(() => undefined)}
          >
            Sign in as owner
          </Button>
        ) : null}
      </div>
    );
  }

  const forbidden = [episodes, lessons, treasury].find(
    (r) => r.error instanceof ApiClientError && (r.error.code === "FORBIDDEN" || r.error.code === "UNAUTHENTICATED"),
  );
  if (forbidden) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 text-[12px] text-muted">
        <span>{forbidden.error instanceof Error ? forbidden.error.message : "Owner access required"}.</span>
        {connectedIsOwner ? (
          <Button variant="secondary" onClick={() => session.signIn().catch(() => undefined)}>
            Sign in as owner
          </Button>
        ) : null}
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
            {treasury.isPending ? (
              <SkeletonRows rows={4} />
            ) : treasury.data ? (
              <TreasuryCard treasury={treasury.data} agentId={agentId} demo={demo} />
            ) : null}
          </Panel>
        </div>
      </div>
    </section>
  );
}
