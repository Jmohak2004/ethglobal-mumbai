"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus, Episode, Lesson } from "@arena/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { useToast } from "@/components/ui/toast";
import { ApiClientError, describeError, getJson, postJson } from "@/lib/api";
import { useSession } from "@/lib/hooks/use-session";
import type { AgentTreasury } from "@/lib/types";

/**
 * Owner-only console. Requests run only when a wallet session exists (or ?owner=1 for the demo outside production).
 * The server decides ownership: a signed-in non-owner gets 403 and the console stays closed.
 */
export function OwnerSection({ agentId, status, demo }: { agentId: string; status: AgentStatus; demo: boolean }) {
  const { address } = useAccount();
  const session = useSession({ prompt: false });
  const enabled = demo || session.signedAddress !== null;
  const q = demo ? "?owner=1" : "";

  const episodes = useQuery({
    queryKey: ["episodes", agentId, demo],
    queryFn: () => getJson<Episode[]>(`/api/agents/${agentId}/episodes${q}`),
    enabled,
    retry: false,
  });
  const lessons = useQuery({
    queryKey: ["lessons", agentId, demo],
    queryFn: () => getJson<Lesson[]>(`/api/agents/${agentId}/lessons${q}`),
    enabled,
    retry: false,
  });
  const treasury = useQuery({
    queryKey: ["treasury", agentId, demo],
    queryFn: () => getJson<AgentTreasury>(`/api/agents/${agentId}/treasury${q}`),
    enabled,
    retry: false,
  });

  const signInButton =
    address && !session.signedIn ? (
      <Button variant="secondary" onClick={() => session.signIn().catch(() => undefined)}>
        Sign in with wallet
      </Button>
    ) : null;

  if (!enabled) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 text-[12px] text-muted">
        <span>Owner console: sign in with the owner wallet to see the decision log, guardrail blocks, AI budget and treasury.</span>
        {signInButton}
      </div>
    );
  }

  const denied = [episodes, lessons, treasury].find(
    (r) => r.error instanceof ApiClientError && (r.error.code === "FORBIDDEN" || r.error.code === "UNAUTHENTICATED"),
  );
  if (denied) {
    const notOwner = denied.error instanceof ApiClientError && denied.error.code === "FORBIDDEN";
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 text-[12px] text-muted">
        <span>{notOwner ? "Only the agent owner can open the owner console. Signed in as a different wallet." : describeError(denied.error)}.</span>
        {notOwner ? null : signInButton}
      </div>
    );
  }

  const episodeList = episodes.data ?? [];
  return (
    <section className="flex flex-col gap-3" aria-label="Owner console">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium">Owner console</h2>
        <Badge tone="accent">Owner only</Badge>
        {demo ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
        <div className="ml-auto">
          <StatusControl agentId={agentId} status={status} demo={demo} />
        </div>
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

/** Pause or resume the agent. Stopped is terminal. The server enforces owner access and the same rule. */
export function StatusControl({ agentId, status, demo }: { agentId: string; status: AgentStatus; demo: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (status === "stopped") return <Badge tone="neutral">Stopped</Badge>;
  const next = status === "active" ? "paused" : "active";
  const label = next === "paused" ? "Pause agent" : "Resume agent";

  const toggle = async () => {
    setBusy(true);
    try {
      await postJson(`/api/agents/${agentId}/status${demo ? "?owner=1" : ""}`, { status: next });
      toast({ title: next === "paused" ? "Paused" : "Resumed", description: `The agent is now ${next}.`, tone: "success" });
      await qc.invalidateQueries({ queryKey: ["my-agents"] });
      router.refresh();
    } catch (err) {
      toast({ title: "Status change failed", description: describeError(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={toggle}>
      {busy ? "Saving…" : label}
    </Button>
  );
}
