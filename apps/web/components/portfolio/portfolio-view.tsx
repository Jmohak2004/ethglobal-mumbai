"use client";

import { useQuery } from "@tanstack/react-query";
import type { PerformanceStats } from "@arena/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";

import { WalletButton } from "@/components/layout/wallet-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Pill, type Tone } from "@/components/ui/pill";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/form";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getJson } from "@/lib/api";
import type { OwnedAgent } from "@/lib/data";
import { fmtBps, fmtNum, fmtPct, fmtUsd, fmtUsdSigned, pnlClass, shortAddr } from "@/lib/format";
import { DEMO_OWNER, getTemplate } from "@/lib/templates";

const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT || "arena_demo_bot";

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
  const owner = demo ? DEMO_OWNER : isConnected && address ? address : null;

  const agents = useQuery({
    queryKey: ["my-agents", owner],
    queryFn: () => getJson<OwnedAgent[]>(`/api/agents?owner=${owner}`),
    enabled: !!owner,
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
          {agents.isPending ? (
            <SkeletonRows rows={3} />
          ) : agents.isError ? (
            <div className="p-3 text-[12px] text-short">{agents.error.message}</div>
          ) : (
            <MyAgentsTable agents={agents.data ?? []} />
          )}
        </Panel>

        <div className="flex flex-col gap-3">
          <HumanCard owner={owner} stats={human.data ?? null} loading={human.isPending} />
          <TelegramCard />
        </div>
      </div>
    </div>
  );
}

function MyAgentsTable({ agents }: { agents: OwnedAgent[] }) {
  const toast = useToast();
  const stub = (what: string) => () =>
    toast({ title: `${what} coming soon`, description: "Needs an owner-signed transaction." });

  return (
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
                  <Button size="sm" onClick={stub("Fund")}>
                    Fund
                  </Button>
                  <Button size="sm" variant="ghost" onClick={stub(a.status === "active" ? "Pause" : "Resume")}>
                    {a.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={a.withdrawableUsd <= 0} onClick={stub("Withdraw")}>
                    Withdraw
                  </Button>
                </div>
              </TD>
            </TR>
          );
        })}
      </tbody>
    </Table>
  );
}

function HumanCard({ owner, stats, loading }: { owner: string; stats: PerformanceStats | null; loading: boolean }) {
  const toast = useToast();
  const [joined, setJoined] = useState(false);
  return (
    <Panel
      title="Humans board"
      right={
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          Join
          <Switch
            label="Join Humans board"
            checked={joined}
            onChange={(v) => {
              setJoined(v);
              toast({
                title: v ? "Opted in to Humans board" : "Opted out",
                description: "Local stub. Ranking needs a CRE attestation of your fills.",
                tone: "success",
              });
            }}
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
