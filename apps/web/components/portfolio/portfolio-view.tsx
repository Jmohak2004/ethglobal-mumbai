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
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Panel } from "@/components/ui/panel";
import { Pill, type Tone } from "@/components/ui/pill";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
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
      <Panel title="Portfolio">
        <div className="flex flex-col items-start gap-3 p-4">
          <p className="text-[12.5px] text-muted">Connect a wallet to see the agents you own and your Humans board stats.</p>
          <div className="flex items-center gap-3">
            <WalletButton />
            <Link href="/portfolio?owner=1" className="text-[12px] text-link hover:underline">
              View the demo owner
            </Link>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[16px] font-semibold">Portfolio</h1>
        <span className="num text-[12px] text-muted">{shortAddr(owner)}</span>
        {demo && !isConnected ? <Badge tone="warn">Demo ?owner=1</Badge> : null}
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[1fr_340px]">
        <Panel
          title="My agents"
          right={
            <Link href="/create" className="text-[12px] text-link hover:underline">
              New agent
            </Link>
          }
        >
          {!canList ? (
            <div className="flex flex-wrap items-center gap-3 p-3 text-[12px] text-muted">
              <span>Sign in with your wallet to list the agents you own.</span>
              <Button variant="secondary" onClick={() => session.signIn().catch(() => undefined)}>
                Sign in
              </Button>
            </div>
          ) : agents.isPending ? (
            <SkeletonRows rows={3} />
          ) : agents.isError ? (
            <div className="p-3 text-[12px] text-short">{describeError(agents.error)}</div>
          ) : (
            <MyAgentsTable agents={agents.data ?? []} demo={demo && !isConnected} />
          )}
        </Panel>

        <div className="flex flex-col gap-3">
          <HumanCard owner={owner} stats={human.data ?? null} loading={human.isPending} signedIn={session.signedIn} />
          <TelegramCard />
        </div>
      </div>
    </div>
  );
}

function MyAgentsTable({ agents, demo }: { agents: OwnedAgent[]; demo: boolean }) {
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

  return (
    <>
      <Table bare>
        <THead>
          <tr>
            <TH>Agent</TH>
            <TH>Status</TH>
            <TH>Mode</TH>
            <TH align="right">Allocation</TH>
            <TH align="right">PnL</TH>
            <TH>Budget</TH>
            <TH align="right">Withdrawable</TH>
            <TH align="right">Actions</TH>
          </tr>
        </THead>
        <tbody>
          {agents.length === 0 ? (
            <EmptyRow colSpan={8}>
              No agents yet. <Link href="/create" className="text-link hover:underline">Create one</Link>.
            </EmptyRow>
          ) : null}
          {agents.map((a) => {
            const tpl = getTemplate(a.config.template);
            const pnl = a.stats?.realizedPnlUsd ?? 0;
            return (
              <TR key={a.id}>
                <TD>
                  <div className="flex items-center gap-2">
                    <Link href={`/agents/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <Badge>{tpl?.name ?? a.config.template}</Badge>
                  </div>
                </TD>
                <TD>
                  <Pill tone={STATUS_TONE[a.status]}>{a.status}</Pill>
                </TD>
                <TD>
                  <Badge tone={a.mode === "paper" ? "warn" : "accent"}>{a.mode === "paper" ? "Paper" : "Live"}</Badge>
                </TD>
                <TD align="right">{fmtUsd(a.allocationUsd)}</TD>
                <TD align="right" className={pnlClass(pnl)}>
                  {fmtUsdSigned(pnl)}
                </TD>
                <TD>
                  <Pill tone={TIER_TONE[a.budgetTier]}>{a.budgetTier}</Pill>
                </TD>
                <TD align="right">{fmtUsd(a.withdrawableUsd, 2)}</TD>
                <TD align="right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      onClick={() => setFundFor(a)}
                      disabled={a.tradingWallet === UNPROVISIONED}
                      title={a.tradingWallet === UNPROVISIONED ? "Trading wallet not provisioned yet" : undefined}
                    >
                      Fund
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
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
                      {CONTRACTS.treasury ? (withdrawing === a.id ? "Withdrawing…" : "Withdraw") : "Contracts not deployed"}
                    </Button>
                  </div>
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
      {fundFor ? <FundModal agent={fundFor} onClose={() => setFundFor(null)} /> : null}
    </>
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
    <Modal open onClose={onClose} title={`Fund ${agent.name}`} width="max-w-md">
      <div className="flex flex-col gap-3 text-[12.5px]">
        <Field label="Amount (USDC)" hint={`Capped at ${fmtUsd(cap, 2)} per agent (MAX_AGENT_ALLOCATION_USD)`}>
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
        <div className="num text-[11.5px] text-muted">To {agent.tradingWallet}</div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="long" disabled={!ok || busy} onClick={send}>
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
      right={
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
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
      <div className="flex flex-col gap-2 p-3">
        {loading ? (
          <SkeletonRows rows={3} className="p-0" />
        ) : stats ? (
          <dl className="num grid grid-cols-2 gap-y-1.5 text-[12px]">
            <dt className="text-muted">PnL</dt>
            <dd className={`text-right ${pnlClass(stats.realizedPnlPct)}`}>
              {fmtPct(stats.realizedPnlPct, 2, true)} · {fmtUsdSigned(stats.realizedPnlUsd)}
            </dd>
            <dt className="text-muted">Win rate</dt>
            <dd className="text-right">{fmtBps(stats.winRateBps)}</dd>
            <dt className="text-muted">Max drawdown</dt>
            <dd className="text-right text-short">-{fmtBps(stats.maxDrawdownBps)}</dd>
            <dt className="text-muted">Trades</dt>
            <dd className="text-right">{fmtNum(stats.trades)}</dd>
            <dt className="text-muted">Volume</dt>
            <dd className="text-right">{fmtUsd(stats.volumeUsd)}</dd>
          </dl>
        ) : (
          <div className="text-[12px] text-muted">No manual trades yet for {shortAddr(owner)}. Trade on the Trade page.</div>
        )}
        {!signedIn ? <div className="text-[11px] text-muted">Sign in with your wallet to change the opt-in.</div> : null}
        {stats?.verified ? (
          <Badge tone="link">✓ CRE-verified stats</Badge>
        ) : (
          <div className="text-[11px] text-muted">Your stats are attested by CRE once you opt in.</div>
        )}
      </div>
    </Panel>
  );
}

function TelegramCard() {
  return (
    <Panel title="Telegram bot">
      <div className="flex flex-col gap-2 p-3 text-[12px]">
        <a
          href={`https://t.me/${TELEGRAM_BOT}`}
          target="_blank"
          rel="noreferrer"
          className="num text-link hover:underline"
        >
          t.me/{TELEGRAM_BOT}
        </a>
        <ul className="num grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <li>/top</li>
          <li>/risk</li>
          <li>/agent &lt;name&gt;</li>
          <li>/humans</li>
          <li>/follow &lt;agent&gt;</li>
          <li>/fork &lt;agent&gt;</li>
        </ul>
        <div className="text-[11px] text-muted">Owners get full alerts: orders, fills, guardrail blocks, top-ups.</div>
      </div>
    </Panel>
  );
}
