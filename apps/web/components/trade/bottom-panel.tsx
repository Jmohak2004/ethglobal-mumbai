"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";

import { Badge } from "@/components/ui/badge";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { getJson } from "@/lib/api";
import { DEFINITIVE_APP_URL, fmtAmount, fmtDateTime, fmtUsd, pnlClass, shortHash, txUrl } from "@/lib/format";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";
import { usePaperFills } from "@/lib/paper-fills";
import type { Balance, Fill, OpenOrder, TradingActivity } from "@/lib/types";

type BottomTab = "orders" | "fills" | "balances";

const TABS: TabItem<BottomTab>[] = [
  { value: "orders", label: "Open orders" },
  { value: "fills", label: "Fills" },
  { value: "balances", label: "Balances" },
];

type LiveActivity = TradingActivity & { live: boolean };

/**
 * Open orders, fills and balances. With a signed-in wallet and Flash live, this polls Flash every 5 s.
 * Paper fills are always labelled as simulated. Without a wallet it shows the demo rows.
 */
export function BottomPanel({ activity }: { activity: TradingActivity }) {
  const [tab, setTab] = useState<BottomTab>("orders");
  const { address } = useAccount();
  const session = useSession({ prompt: false });
  const platform = usePlatform();
  const paper = usePaperFills();

  const funder = session.signedIn ? session.address : null;
  const live = useQuery({
    queryKey: ["flash-activity", funder],
    queryFn: () => getJson<LiveActivity>(`/api/flash/orders?funder=${funder}`),
    enabled: funder !== null && platform.data?.flashLive === true,
    refetchInterval: 5000,
  });

  let openOrders: OpenOrder[] = [];
  let fills: Fill[] = paper;
  let balances: Balance[] = [];
  let note: string | null = null;

  if (funder && live.data?.live) {
    openOrders = live.data.openOrders;
    fills = [...live.data.fills, ...paper];
    balances = live.data.balances;
  } else if (funder) {
    note = "Paper mode: live orders and balances need EXECUTION_MODE=live and a Flash key. Simulated fills are listed below.";
  } else if (address) {
    note = "Sign in with your wallet to load your Flash orders, fills and balances.";
  } else {
    openOrders = activity.openOrders;
    fills = [...paper, ...activity.fills];
    balances = activity.balances;
    note = activity.source === "demo" ? "Demo data. Connect a wallet to see your Flash activity." : null;
  }

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-panel" aria-label="Account activity">
      <div className="flex items-center justify-between px-3">
        <Tabs value={tab} items={TABS} onChange={setTab} className="border-b-0" />
        {note ? <span className="max-w-md truncate text-[11px] text-muted" title={note}>{note}</span> : null}
      </div>
      <div className="overflow-x-auto border-t border-border">
        {tab === "orders" ? (
          <Table bare>
            <THead>
              <tr>
                <TH>Time (UTC)</TH>
                <TH>Asset</TH>
                <TH>Side</TH>
                <TH>Type</TH>
                <TH align="right">Size</TH>
                <TH align="right">Price</TH>
                <TH>Status</TH>
                <TH align="right">Action</TH>
              </tr>
            </THead>
            <tbody>
              {openOrders.length === 0 ? <EmptyRow colSpan={8}>No open orders.</EmptyRow> : null}
              {openOrders.map((o) => (
                <TR key={o.id}>
                  <TD className="text-muted">{fmtDateTime(o.ts)}</TD>
                  <TD>{o.asset}</TD>
                  <TD className={o.side === "buy" ? "text-long" : "text-short"}>{o.side}</TD>
                  <TD>{o.orderType}</TD>
                  <TD align="right">{fmtUsd(o.sizeUsd)}</TD>
                  <TD align="right">{fmtAmount(o.priceUsd, 2)}</TD>
                  <TD className="text-muted">{o.status.replace("_", " ")}</TD>
                  <TD align="right">
                    {/* Flash cancels need a signed cancel message that ARENA cannot build yet, so this links out. */}
                    <a
                      href={DEFINITIVE_APP_URL}
                      target="_blank"
                      rel="noreferrer"
                      title="Flash cancels are signed in the Definitive app. ARENA cannot sign the cancel message yet."
                      className="text-[11.5px] text-link hover:underline"
                    >
                      Cancel via Definitive app ↗
                    </a>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : null}

        {tab === "fills" ? (
          <Table bare>
            <THead>
              <tr>
                <TH>Time (UTC)</TH>
                <TH>Asset</TH>
                <TH>Side</TH>
                <TH align="right">Size</TH>
                <TH align="right">Price</TH>
                <TH align="right">Fee</TH>
                <TH>Tx</TH>
              </tr>
            </THead>
            <tbody>
              {fills.length === 0 ? <EmptyRow colSpan={7}>No fills yet.</EmptyRow> : null}
              {fills.map((f) => (
                <TR key={f.id}>
                  <TD className="text-muted">{f.ts ? fmtDateTime(f.ts) : "-"}</TD>
                  <TD>{f.asset}</TD>
                  <TD className={f.side === "buy" ? "text-long" : "text-short"}>{f.side}</TD>
                  <TD align="right">{fmtUsd(f.sizeUsd)}</TD>
                  <TD align="right">{fmtAmount(f.priceUsd, 2)}</TD>
                  <TD align="right" className="text-muted">
                    {fmtUsd(f.feeUsd, 4)}
                  </TD>
                  <TD>
                    {f.txHash ? (
                      <a href={txUrl(f.txHash)} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        {shortHash(f.txHash)}
                      </a>
                    ) : (
                      <Badge tone="warn">simulated</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : null}

        {tab === "balances" ? (
          <Table bare>
            <THead>
              <tr>
                <TH>Asset</TH>
                <TH align="right">Amount</TH>
                <TH align="right">Value</TH>
              </tr>
            </THead>
            <tbody>
              {balances.length === 0 ? <EmptyRow colSpan={3}>No balances to show.</EmptyRow> : null}
              {balances.map((b) => (
                <TR key={b.symbol}>
                  <TD>{b.symbol}</TD>
                  <TD align="right">{fmtAmount(b.amount, 6)}</TD>
                  <TD align="right" className={pnlClass(b.valueUsd)}>
                    {fmtUsd(b.valueUsd, 2)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : null}
      </div>
    </section>
  );
}
