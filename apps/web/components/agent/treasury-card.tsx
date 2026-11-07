"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Pill, type Tone } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/api";
import { CONTRACTS } from "@/lib/contracts";
import { NotDeployedError, readWithdrawable, withdrawOnchain } from "@/lib/onchain";
import type { AgentTreasury, TopUp } from "@/lib/types";
import { fmtAmount, fmtBps, fmtDateTime, fmtUsd, shortHash, txUrl, zgTxUrl } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";

const TOPUP_TONE: Record<TopUp["status"], Tone> = { credited: "long", pending: "warn" };

/** Commission treasury: balances, reserve, withdrawable (read from AgentTreasury when deployed), and top-ups. */
export function TreasuryCard({ treasury, agentId, demo }: { treasury: AgentTreasury; agentId: string; demo: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const deployed = CONTRACTS.treasury !== null;
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const onchain = useQuery({
    queryKey: ["withdrawable", agentId],
    queryFn: () => readWithdrawable(wagmiConfig, agentId),
    enabled: deployed,
    refetchInterval: 30_000,
    retry: false,
  });
  const withdrawable = deployed && onchain.data !== undefined ? onchain.data : treasury.withdrawableUsd;
  const amountUsd = Math.min(withdrawable, Math.max(0.01, amount ?? withdrawable));
  const amountOk = withdrawable > 0 && Number.isFinite(amountUsd) && (amount ?? withdrawable) <= withdrawable;

  const withdraw = async () => {
    if (!address) {
      openConnectModal?.();
      return;
    }
    setBusy(true);
    try {
      const hash = await withdrawOnchain(wagmiConfig, agentId, amountUsd);
      toast({ title: "Withdrawn", description: `${fmtUsd(amountUsd, 2)} sent to the owner wallet. ${shortHash(hash)}`, tone: "success" });
      setAmount(null);
      await qc.invalidateQueries({ queryKey: ["withdrawable", agentId] });
      await qc.invalidateQueries({ queryKey: ["treasury", agentId] });
    } catch (err) {
      toast({
        title: "Withdraw failed",
        description: err instanceof NotDeployedError ? "Contracts not deployed" : describeError(err),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <dl className="num grid grid-cols-2 gap-y-2 text-sm [&_dt]:font-sans">
        <dt className="text-muted">Treasury balance</dt>
        <dd className="text-right">{fmtUsd(treasury.balanceUsd, 4)}</dd>
        <dt className="text-muted">Kept in reserve (3 days of AI)</dt>
        <dd className="text-right">{fmtUsd(treasury.reserveUsd, 4)}</dd>
        <dt className="text-muted">You can withdraw</dt>
        <dd className="text-right text-long">
          {fmtUsd(withdrawable, 4)} <span className="text-muted">{deployed && onchain.data !== undefined ? "onchain" : "estimate"}</span>
        </dd>
        <dt className="text-muted">Commission to pay</dt>
        <dd className="text-right">
          {fmtUsd(treasury.commissionOwedUsd, 4)} <span className="text-muted">@ {fmtBps(treasury.commissionBps)}</span>
        </dd>
        <dt className="text-muted">Commission paid so far</dt>
        <dd className="text-right">{fmtUsd(treasury.commissionPaidUsd, 4)}</dd>
      </dl>

      {deployed ? (
        <div className="flex flex-col gap-2">
          <Field label="Amount (USD)" hint={`Up to ${fmtUsd(withdrawable, 4)} withdrawable`}>
            <Input
              type="number"
              aria-label="Withdraw amount"
              min={0.01}
              max={withdrawable}
              step={0.01}
              value={amount ?? fmtAmount(withdrawable, 4)}
              onChange={(e) => setAmount(e.target.valueAsNumber)}
            />
          </Field>
          <Button
            variant="secondary"
            disabled={demo || !amountOk || busy}
            onClick={withdraw}
          >
            {demo ? "Connect the owner wallet to withdraw" : busy ? "Withdrawing…" : `Withdraw ${fmtUsd(amountUsd, 2)}`}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" disabled>
          Contracts not deployed
        </Button>
      )}

      <div>
        <div className="mb-1 text-sm font-medium text-text">Recent AI top-ups</div>
        {treasury.topUps.length === 0 ? (
          <div className="text-sm text-muted">None yet. Top-ups appear when the agent converts commission into AI credit.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {treasury.topUps.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 py-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="num text-muted">{fmtDateTime(t.ts)}</span>
                  <Pill tone={TOPUP_TONE[t.status]}>{t.status}</Pill>
                </div>
                <div className="num">
                  {fmtUsd(t.usdcAmount, 2)} USDC → {fmtAmount(t.zgAmount, 2)} 0G
                </div>
                <div className="num flex flex-wrap gap-x-3 text-accent-fg">
                  <a href={txUrl(t.basePayTx)} target="_blank" rel="noreferrer" className="hover:underline">
                    Base {shortHash(t.basePayTx)}
                  </a>
                  {t.zgTransferTx ? (
                    <a href={zgTxUrl(t.zgTransferTx)} target="_blank" rel="noreferrer" className="hover:underline">
                      0G transfer {shortHash(t.zgTransferTx)}
                    </a>
                  ) : null}
                  {t.depositTx ? (
                    <a href={zgTxUrl(t.depositTx)} target="_blank" rel="noreferrer" className="hover:underline">
                      deposit {shortHash(t.depositTx)}
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
