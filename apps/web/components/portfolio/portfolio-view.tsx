"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PerformanceStats } from "@arena/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";

import { WalletButton } from "@/components/layout/wallet-button";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconBot, IconWallet } from "@/components/ui/icons";
import { Container, PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Field, Input, Switch } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Panel } from "@/components/ui/panel";
import { Pill, type Tone } from "@/components/ui/pill";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { describeError, getJson, postJson } from "@/lib/api";
import { CONTRACTS } from "@/lib/contracts";
import { fmtBps, fmtNum, fmtPct, fmtUsd, fmtUsdSigned, pnlClass, shortAddr } from "@/lib/format";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";
import { fundOnchain, NotDeployedError, withdrawOnchain } from "@/lib/onchain";
import { DEMO_OWNER, getTemplate } from "@/lib/templates";
import type { HumansPrefs, OwnedAgent } from "@/lib/types";
import { wagmiConfig } from "@/lib/wagmi";

const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT || "arena_demo_bot";
const UNPROVISIONED = "0x0000000000000000000000000000000000000000";

const STATUS_TONE: Record<OwnedAgent["status"], Tone> = { active: "long", paused: "warn", stopped: "muted" };
const STATUS_LABEL: Record<OwnedAgent["status"], string> = { active: "Active", paused: "Paused", stopped: "Stopped" };
const TIER_LABEL: Record<OwnedAgent["budgetTier"], string> = { healthy: "Healthy", low: "Low", critical: "Critical", empty: "Empty" };
const TIER_TONE: Record<OwnedAgent["budgetTier"], Tone> = {
  healthy: "long",
  low: "warn",
  critical: "short",
  empty: "muted",
};

export function PortfolioView() {
  const sp = useSearchParams();
  const demo = sp.get("owner") === "1";
  const { address, isConnected } = useAccount();
  const session = useSession({ prompt: true });
  const owner = demo && !isConnected ? DEMO_OWNER : isConnected && address ? address : null;
  const canList = demo ? !isConnected : session.signedIn;

  const agents = useQuery({
    queryKey: ["my-agents", owner, demo],
    queryFn: () => getJson<OwnedAgent[]>(`/api/agents?owner=${owner}${demo && !isConnected ? "&demo=1" : ""}`),
    enabled: !!owner && canList,
    retry: false,
  });
  const human = useQuery({
    queryKey: ["human-stats", owner],
    queryFn: () => getJson<PerformanceStats | null>(`/api/humans?address=${owner}`),
    enabled: !!owner,
  });

  if (!owner) {
    return (
      <Container className="py-8 md:py-10">
        <PageHeader title="Portfolio" description="Your agents, their earnings, and your place on the Humans board." />
        <div className="mt-8 rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]">
          <EmptyState
            icon={<IconWallet size={18} />}
            title="Connect a wallet to get started"
            description="Your portfolio lists the agents you own and your Humans board stats. Browsing the leaderboard needs no wallet."
            action={
              <div className="flex flex-col items-center gap-3">
                <WalletButton size="lg" />
                <Link href="/portfolio?owner=1" className="text-sm text-accent-fg hover:underline">
                  Or look at the demo owner
                </Link>
              </div>
            }
          />
        </div>
      </Container>
    );
  }

  const list = agents.data ?? [];
  const totalPnl = list.reduce((sum, a) => sum + (a.stats?.realizedPnlUsd ?? 0), 0);
  const totalWithdrawable = list.reduce((sum, a) => sum + a.withdrawableUsd, 0);

  return (
    <Container className="flex flex-col gap-8 py-8 md:py-10">
      <PageHeader
        title="Portfolio"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            Your agents and earnings. Wallet <span className="num text-text-2">{shortAddr(owner)}</span>
            {demo && !isConnected ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
          </span>
        }
        actions={
          <ButtonLink href="/create" variant="primary">
            New agent
          </ButtonLink>
        }
      />

      {canList && agents.isSuccess ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Agents" value={String(list.length)} sub={`${list.filter((a) => a.status === "active").length} active`} />
          <StatCard label="Total profit" value={fmtUsdSigned(totalPnl)} tone={totalPnl >= 0 ? "long" : "short"} sub="Across all your agents" />
          <StatCard label="Ready to withdraw" value={fmtUsd(totalWithdrawable, 2)} sub="Earned commission" />
        </div>
      ) : null}

      <section aria-label="My agents" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-[-0.012em]">My agents</h2>
        {!canList ? (
          <div className="rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]">
            <EmptyState
              compact
              icon={<IconBot size={18} />}
              title="Sign in to see your agents"
              description="One free signature proves the wallet is yours. It is not a transaction."
              action={
                <Button variant="primary" onClick={() => session.signIn().catch(() => undefined)}>
                  Sign in
                </Button>
              }
            />
          </div>
        ) : agents.isPending ? (
          <SkeletonRows rows={3} className="rounded-xl border border-border bg-panel" />
        ) : agents.isError ? (
          <div className="rounded-xl bg-short-soft px-4 py-3 text-base text-short">{describeError(agents.error)}</div>
        ) : (
          <MyAgents agents={list} demo={demo && !isConnected} />
        )}
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <HumanCard owner={owner} stats={human.data ?? null} loading={human.isPending} signedIn={session.signedIn} />
        <TelegramCard />
      </div>
    </Container>
  );
}

function MyAgents({ agents, demo }: { agents: OwnedAgent[]; demo: boolean }) {
  const toast = useToast();
  const [fundFor, setFundFor] = useState<OwnedAgent | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const { openConnectModal } = useConnectModal();
  const { address } = useAccount();

  const withdraw = async (a: OwnedAgent) => {
    if (!address) return openConnectModal?.();
    setWithdrawing(a.id);
    try {
      await withdrawOnchain(wagmiConfig, a.id, a.withdrawableUsd);
      toast({ title: "Withdrawn", description: `${fmtUsd(a.withdrawableUsd, 2)} sent to your wallet.`, tone: "success" });
      await qc.invalidateQueries({ queryKey: ["my-agents"] });
    } catch (err) {
      toast({
        title: "Withdraw failed",
        description: err instanceof NotDeployedError ? "Contracts not deployed" : describeError(err),
        tone: "error",
      });
    } finally {
      setWithdrawing(null);
    }
  };

  /** Owner pause/resume through the API (session-gated; the demo owner uses ?owner=1 outside production). */
  const toggleStatus = async (a: OwnedAgent) => {
    const next = a.status === "active" ? "paused" : "active";
    setStatusBusy(a.id);
    try {
      await postJson(`/api/agents/${a.id}/status${demo ? "?owner=1" : ""}`, { status: next });
      toast({ title: next === "paused" ? "Paused" : "Resumed", description: `${a.name} is now ${next}.`, tone: "success" });
      await qc.invalidateQueries({ queryKey: ["my-agents"] });
    } catch (err) {
      toast({ title: "Status change failed", description: describeError(err), tone: "error" });
    } finally {
      setStatusBusy(null);
    }
  };

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]">
        <EmptyState
          icon={<IconBot size={18} />}
          title="No agents yet"
          description="Create your first agent in three quick steps. It starts in paper mode, so nothing risks real money."
          action={
            <ButtonLink href="/create" variant="primary">
              Create an agent
            </ButtonLink>
          }
        />
      </div>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {agents.map((a) => {
          const tpl = getTemplate(a.config.template);
          const pnl = a.stats?.realizedPnlUsd ?? 0;
          const noWallet = a.tradingWallet === UNPROVISIONED;
          return (
            <li key={a.id} className="rounded-xl border border-border bg-panel p-4 shadow-[var(--shadow-card)] sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/agents/${a.id}`} className="text-lg font-semibold tracking-[-0.012em] hover:underline">
                      {a.name}
                    </Link>
                    <Pill tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Pill>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge>{tpl?.name ?? a.config.template}</Badge>
                    <Badge tone={a.mode === "paper" ? "warn" : "accent"}>{a.mode === "paper" ? "Paper" : "Live"}</Badge>
                  </div>
                </div>
                <ButtonLink href={`/agents/${a.id}`} variant="secondary" size="sm">
                  Open
                </ButtonLink>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-panel-2 p-3 sm:grid-cols-4">
                <Fact label="Profit" value={<span className={pnlClass(pnl)}>{fmtUsdSigned(pnl)}</span>} />
                <Fact label="Funds" value={fmtUsd(a.allocationUsd)} />
                <Fact label="AI credit" value={<Pill tone={TIER_TONE[a.budgetTier]}>{TIER_LABEL[a.budgetTier]}</Pill>} />
                <Fact label="Can withdraw" value={fmtUsd(a.withdrawableUsd, 2)} />
              </dl>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setFundFor(a)}
                  disabled={noWallet}
                  title={noWallet ? "Trading wallet not provisioned yet" : undefined}
                >
                  Fund
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={a.status === "stopped" || statusBusy === a.id}
                  title={a.status === "stopped" ? "Stopped agents cannot be changed" : undefined}
                  onClick={() => toggleStatus(a)}
                >
                  {statusBusy === a.id ? "Saving…" : a.status === "active" ? "Pause" : a.status === "paused" ? "Resume" : "Stopped"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={a.withdrawableUsd <= 0 || withdrawing === a.id || !CONTRACTS.treasury}
                  onClick={() => withdraw(a)}
                  title={CONTRACTS.treasury ? undefined : "Contracts not deployed"}
                >
                  {CONTRACTS.treasury ? (withdrawing === a.id ? "Withdrawing…" : "Withdraw") : "Withdraw (contracts not deployed)"}
                </Button>
                {noWallet ? <span className="text-xs text-muted">Its trading wallet is still being set up.</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {fundFor ? <FundModal agent={fundFor} onClose={() => setFundFor(null)} /> : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num flex min-h-6 items-center text-base">{value}</dd>
    </div>
  );
}

/** USDC transfer to the agent's trading wallet, capped at MAX_AGENT_ALLOCATION_USD. */
function FundModal({ agent, onClose }: { agent: OwnedAgent; onClose: () => void }) {
  const toast = useToast();
  const platform = usePlatform();
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const qc = useQueryClient();
  const cap = platform.data?.caps.maxAgentAllocationUsd ?? agent.allocationUsd;
  const [amount, setAmount] = useState(Math.min(1, cap));
  const [busy, setBusy] = useState(false);
  const ok = Number.isFinite(amount) && amount >= 0.01 && amount <= cap;

  const send = async () => {
    if (!address) return openConnectModal?.();
    setBusy(true);
    try {
      await fundOnchain(wagmiConfig, agent.tradingWallet, amount);
      toast({ title: "Funded", description: `${fmtUsd(amount, 2)} USDC sent to ${agent.name}.`, tone: "success" });
      await qc.invalidateQueries({ queryKey: ["my-agents"] });
      onClose();
    } catch (err) {
      toast({ title: "Fund failed", description: err instanceof NotDeployedError ? "Contracts not deployed" : describeError(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Fund ${agent.name}`} description="Send USDC to the agent's trading wallet." width="max-w-md">
      <div className="flex flex-col gap-4 text-base">
        <Field label="Amount (USDC)" hint={`Capped at ${fmtUsd(cap, 2)} per agent.`}>
          <Input
            type="number"
            aria-label="Fund amount"
            min={0.01}
            max={cap}
            step={0.01}
            value={Number.isFinite(amount) ? amount : ""}
            onChange={(e) => setAmount(e.target.valueAsNumber)}
          />
        </Field>
        <div className="num break-all text-xs text-muted">To {agent.tradingWallet}</div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok || busy} onClick={send}>
            {busy ? "Sending…" : `Send ${fmtUsd(ok ? amount : 0, 2)} USDC`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function HumanCard({
  owner,
  stats,
  loading,
  signedIn,
}: {
  owner: string;
  stats: PerformanceStats | null;
  loading: boolean;
  signedIn: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: ["humans-prefs"],
    queryFn: () => getJson<HumansPrefs>("/api/users/me"),
    enabled: signedIn,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (optIn: boolean) => postJson<HumansPrefs>("/api/users/me", { humansBoardOptIn: optIn }),
    onSuccess: (next) => {
      qc.setQueryData(["humans-prefs"], next);
      toast({
        title: next.humansBoardOptIn ? "Opted in to Humans board" : "Opted out",
        description: next.humansBoardOptIn ? "Your manual trades are eligible for the Humans board." : "Your manual trades are no longer ranked.",
        tone: "success",
      });
    },
    onError: (err) => toast({ title: "Could not save", description: describeError(err), tone: "error" }),
  });
  const joined = prefs.data?.humansBoardOptIn ?? false;
  return (
    <Panel
      title="Humans board"
      description="Join to rank your own manual trades next to the AI agents."
      right={
        <div className="flex items-center gap-2 text-sm text-muted">
          Join
          <Switch
            label="Join Humans board"
            checked={joined}
            disabled={!signedIn || !prefs.isSuccess || save.isPending}
            onChange={(v) => save.mutate(v)}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {loading ? (
          <SkeletonRows rows={3} className="p-0" />
        ) : stats ? (
          <dl className="num grid grid-cols-2 gap-y-2 text-sm [&_dt]:font-sans">
            <dt className="font-sans text-muted">Return</dt>
            <dd className={`text-right ${pnlClass(stats.realizedPnlPct)}`}>
              {fmtPct(stats.realizedPnlPct, 2, true)} · {fmtUsdSigned(stats.realizedPnlUsd)}
            </dd>
            <dt className="font-sans text-muted">Win rate</dt>
            <dd className="text-right">{fmtBps(stats.winRateBps)}</dd>
            <dt className="font-sans text-muted">Worst dip</dt>
            <dd className="text-right text-short">-{fmtBps(stats.maxDrawdownBps)}</dd>
            <dt className="font-sans text-muted">Trades</dt>
            <dd className="text-right">{fmtNum(stats.trades)}</dd>
            <dt className="font-sans text-muted">Volume</dt>
            <dd className="text-right">{fmtUsd(stats.volumeUsd)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted">
            No manual trades yet for <span className="num">{shortAddr(owner)}</span>. Make one on the{" "}
            <Link href="/trade" className="text-accent-fg hover:underline">
              Trade page
            </Link>{" "}
            and it shows up here.
          </p>
        )}
        {!signedIn ? <p className="text-xs text-muted">Sign in with your wallet to change this setting.</p> : null}
        {stats?.verified ? (
          <Badge tone="success">Verified stats</Badge>
        ) : (
          <p className="text-xs text-muted">Once you opt in, your stats are independently verified too.</p>
        )}
      </div>
    </Panel>
  );
}

function TelegramCard() {
  return (
    <Panel title="Telegram bot" description="Follow agents and get alerts in chat.">
      <div className="flex flex-col gap-3 p-4 text-sm">
        <a href={`https://t.me/${TELEGRAM_BOT}`} target="_blank" rel="noreferrer" className="num w-fit text-accent-fg hover:underline">
          t.me/{TELEGRAM_BOT}
        </a>
        <ul className="num grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted">
          <li>/top</li>
          <li>/risk</li>
          <li>/agent &lt;name&gt;</li>
          <li>/humans</li>
          <li>/follow &lt;agent&gt;</li>
          <li>/fork &lt;agent&gt;</li>
        </ul>
        <p className="text-xs text-muted">Owners also get alerts for orders, fills, blocked trades and AI top-ups.</p>
      </div>
    </Panel>
  );
}
