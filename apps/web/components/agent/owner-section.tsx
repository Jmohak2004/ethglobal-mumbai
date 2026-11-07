"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus, Lesson } from "@arena/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";

import { BudgetCard } from "@/components/agent/budget-card";
import { DecisionLog } from "@/components/agent/decision-log";
import { GuardrailList } from "@/components/agent/guardrail-list";
import { LessonsList } from "@/components/agent/lessons-list";
import { PaperFundingCard } from "@/components/agent/paper-funding-card";
import { PaperPortfolioCard } from "@/components/agent/paper-portfolio-card";
import { TreasuryCard } from "@/components/agent/treasury-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { IconLock } from "@/components/ui/icons";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, describeError, getJson, postJson } from "@/lib/api";
import { shortAddr } from "@/lib/format";
import { useAgentRuntime } from "@/lib/hooks/use-agent-runtime";
import { useSession } from "@/lib/hooks/use-session";
import type { AgentTreasury, DecisionEpisode, PaperLedgerView } from "@/lib/types";

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
    queryFn: () => getJson<DecisionEpisode[]>(`/api/agents/${agentId}/episodes${q}`),
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
        <GateCard
          title="This is your agent"
          body="Sign in once (a free signature) to open the owner console with the decision log, safety blocks, AI budget and treasury."
          action={
            <Button variant="primary" onClick={signIn}>
              Sign in to open your console
            </Button>
          }
        />
      );
    }
    return (
      <GateCard
        title="Owner console"
        body="The decision log, safety blocks, AI budget and treasury are visible only to the owner. Sign in with the owner wallet to see them."
        action={signInButton}
      />
    );
  }

  const denied = [episodes, lessons, treasury].find(
    (r) => r.error instanceof ApiClientError && (r.error.code === "FORBIDDEN" || r.error.code === "UNAUTHENTICATED"),
  );
  if (denied) {
    const notOwner = denied.error instanceof ApiClientError && denied.error.code === "FORBIDDEN";
    return (
      <GateCard
        title="Owner console"
        body={notOwner ? "Only the agent's owner can open this. You are signed in with a different wallet." : `${describeError(denied.error)}.`}
        action={notOwner ? null : signInButton}
      />
    );
  }

  const episodeList = episodes.data ?? [];
  const ownerRuntime = runtime.data?.viewer === "owner" ? runtime.data : undefined;
  const blocks = episodeList.filter((e) => e.verdict.kind === "reject").length;

  return (
    <section className="flex flex-col gap-3" aria-label="Owner console">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-[-0.012em]">Owner console</h2>
        <Badge tone="accent">Only you see this</Badge>
        {demo ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
      </div>
      <p className="-mt-1 max-w-2xl text-sm text-muted">
        Open a section to dig in. The decision log is the best place to start: it shows what the AI expected, what it
        proposed, and whether the safety rules agreed.
      </p>

      <Disclosure
        defaultOpen
        title="Decision log"
        description="Every decision the agent made, with the safety verdict and proof of the AI call."
        right={<Badge>{episodeList.length}</Badge>}
      >
        {episodes.isPending ? <SkeletonRows rows={5} /> : <DecisionLog episodes={episodeList} />}
      </Disclosure>

      <Disclosure
        title="Safety blocks"
        description="Times a safety rule stopped a trade the AI wanted."
        right={<Badge tone={blocks > 0 ? "warn" : "neutral"}>{blocks}</Badge>}
      >
        {episodes.isPending ? <SkeletonRows rows={2} /> : <GuardrailList episodes={episodeList} />}
      </Disclosure>

      <Disclosure title="AI budget" description="How much AI credit is left, and how long it will last.">
        {treasury.isPending ? <SkeletonRows rows={4} /> : treasury.data ? <BudgetCard zg={treasury.data.zg} /> : null}
      </Disclosure>

      {paper ? (
        <Disclosure title="Paper portfolio" description="The practice account: cash, positions and profit.">
          {runtime.isPending ? <SkeletonRows rows={4} /> : <PaperPortfolioCard portfolio={ownerRuntime?.portfolio} />}
        </Disclosure>
      ) : null}

      <Disclosure title="Treasury and withdrawals" description="Commission earned, AI top-ups, and money you can withdraw.">
        {treasury.isPending ? (
          <SkeletonRows rows={4} />
        ) : treasury.data ? (
          <TreasuryCard treasury={treasury.data} agentId={agentId} demo={demo} />
        ) : null}
      </Disclosure>

      {paper ? (
        <Disclosure
          title="Practice self-funding"
          description="A simulated version of how an agent turns profit into AI credit."
          right={<Badge tone="warn">Paper</Badge>}
        >
          <PaperFundingCard ledger={ledger.data} loading={ledger.isPending} />
        </Disclosure>
      ) : null}

      <Disclosure title="Lessons" description="What the agent learned from past trades, stored as proof on 0G.">
        {lessons.isPending ? <SkeletonRows rows={3} /> : <LessonsList lessons={lessons.data ?? []} />}
      </Disclosure>
    </section>
  );
}

function GateCard({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <section aria-label="Owner console" className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-border-strong bg-panel px-5 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-panel-2 text-muted">
        <IconLock size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold">{title}</div>
        <p className="max-w-xl text-sm text-muted">{body}</p>
      </div>
      {action}
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
    <Button variant="secondary" disabled={busy} onClick={toggle}>
      {busy ? "Saving…" : label}
    </Button>
  );
}
