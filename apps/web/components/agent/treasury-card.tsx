import { Button } from "@/components/ui/button";
import { Pill, type Tone } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import type { AgentTreasury, TopUp } from "@/lib/data";
import { fmtAmount, fmtBps, fmtDateTime, fmtUsd, shortHash, txUrl, zgTxUrl } from "@/lib/format";

const TOPUP_TONE: Record<TopUp["status"], Tone> = { credited: "long", pending: "warn" };

/** Commission treasury: balance, reserve, withdrawable, and top-up history with tx links. */
export function TreasuryCard({ treasury }: { treasury: AgentTreasury }) {
  const toast = useToast();
  return (
    <div className="flex flex-col gap-3 p-3">
      <dl className="num grid grid-cols-2 gap-y-1.5 text-[12px]">
        <dt className="text-muted">Treasury balance</dt>
        <dd className="text-right">{fmtUsd(treasury.balanceUsd, 4)}</dd>
        <dt className="text-muted">Reserve (3 days)</dt>
        <dd className="text-right">{fmtUsd(treasury.reserveUsd, 4)}</dd>
        <dt className="text-muted">Withdrawable</dt>
        <dd className="text-right text-long">{fmtUsd(treasury.withdrawableUsd, 4)}</dd>
        <dt className="text-muted">Commission owed</dt>
        <dd className="text-right">
          {fmtUsd(treasury.commissionOwedUsd, 4)} <span className="text-muted">@ {fmtBps(treasury.commissionBps)}</span>
        </dd>
        <dt className="text-muted">Commission paid</dt>
        <dd className="text-right">{fmtUsd(treasury.commissionPaidUsd, 4)}</dd>
      </dl>
      <Button
        variant="secondary"
        disabled={treasury.withdrawableUsd <= 0}
        onClick={() =>
          toast({ title: "Withdraw coming soon", description: "Owner-signed withdraw(agentId, amount) is not wired yet." })
        }
      >
        Withdraw {fmtUsd(treasury.withdrawableUsd, 2)}
      </Button>

      <div>
        <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted">Recent top-ups</div>
        {treasury.topUps.length === 0 ? (
          <div className="text-[12px] text-muted">No top-ups yet.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {treasury.topUps.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 py-2 text-[11.5px]">
                <div className="flex items-center justify-between">
                  <span className="num text-muted">{fmtDateTime(t.ts)}</span>
                  <Pill tone={TOPUP_TONE[t.status]}>{t.status}</Pill>
                </div>
                <div className="num">
                  {fmtUsd(t.usdcAmount, 2)} USDC → {fmtAmount(t.zgAmount, 2)} 0G
                </div>
                <div className="num flex flex-wrap gap-x-3 text-link">
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
