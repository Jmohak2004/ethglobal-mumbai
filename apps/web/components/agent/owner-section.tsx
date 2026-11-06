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
import { PaperFundingCard } from "@/components/agent/paper-funding-card";
import { PaperPortfolioCard } from "@/components/agent/paper-portfolio-card";
import { RunNowButton } from "@/components/agent/run-now-button";
import { TreasuryCard } from "@/components/agent/treasury-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, describeError, getJson, postJson } from "@/lib/api";
import { shortAddr } from "@/lib/format";
import { useAgentRuntime } from "@/lib/hooks/use-agent-runtime";
import { useSession } from "@/lib/hooks/use-session";
import type { AgentTreasury, PaperLedgerView } from "@/lib/types";

/**
 * Owner-only console. Requests run only when a wallet session exists (or ?owner=1 for the demo outside production).
 * The server decides ownership: a signed-in non-owner gets 403 and the console stays closed. `ownerShort` is the
 * public shortened owner address; it is used only to recognise the owner wallet for the sign-in prompt.
 */
export function OwnerSection({
  agentId,
  status,
  demo,
  mode,
  ownerShort,
}: {
  agentId: string;
  status: AgentStatus;
  demo: boolean;
  mode: "paper" | "live";
  ownerShort: string;
}) {
  const toast = useToast();
  const { address } = useAccount();
  const session = useSession({ prompt: false });
  const enabled = demo || session.signedAddress !== null;
  const q = demo ? "?owner=1" : "";
  const paper = mode === "paper";

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
  const runtime = useAgentRuntime(agentId, demo);
  const ledger = useQuery({
    queryKey: ["ledger", agentId, demo],
    queryFn: () => getJson<PaperLedgerView>(`/api/agents/${agentId}/ledger${q}`),
    enabled: enabled && paper,
    refetchInterval: 15_000,
    retry: false,
  });

  const signIn = () =>
    session.signIn().catch((err: unknown) => toast({ title: "Sign-in failed", description: describeError(err), tone: "error" }));

  const signInButton =
    address && !session.signedIn ? (
      <Button variant="secondary" onClick={signIn}>
        Sign in with wallet
      </Button>
    ) : null;

  if (!enabled) {
    const walletIsOwner = session.address !== null && shortAddr(session.address).toLowerCase() === ownerShort.toLowerCase();
    if (walletIsOwner) {
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-long/40 px-4 py-3 text-[12px] text-muted">
          <span>This wallet owns the agent. Sign in once to open the owner console: decision log, guardrail blocks, AI budget and treasury.</span>
          <Button variant="primary" onClick={signIn}>
            Sign in to view your agent&apos;s console
          </Button>
        </div>
      );
    }
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
  const ownerRuntime = runtime.data?.viewer === "owner" ? runtime.data : undefined;

  const budgetPanel = (
    <Panel title="AI budget">
      {treasury.isPending ? <SkeletonRows rows={4} /> : treasury.data ? <BudgetCard zg={treasury.data.zg} /> : null}
    </Panel>
  );

  return (
    <section className="flex flex-col gap-3" aria-label="Owner console">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium">Owner console</h2>
        <Badge tone="accent">Owner only</Badge>
        {demo ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <RunNowButton agentId={agentId} status={status} demo={demo} runtime={runtime.data} />
          <StatusControl agentId={agentId} status={status} demo={demo} />
        </div>
      </div>

      {paper ? (
        <div className="grid gap-3 md:grid-cols-[1fr_340px]">
          <PaperFundingCard ledger={ledger.data} loading={ledger.isPending} />
          {budgetPanel}
        </div>
      ) : null}

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
          {paper ? (
            <Panel title="Paper portfolio">
              {runtime.isPending ? <SkeletonRows rows={4} /> : <PaperPortfolioCard portfolio={ownerRuntime?.portfolio} />}
            </Panel>
          ) : (
            budgetPanel
          )}
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
