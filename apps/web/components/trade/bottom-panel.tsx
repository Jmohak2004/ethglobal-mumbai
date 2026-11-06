"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import type { TradingActivity } from "@/lib/data";
import { fmtAmount, fmtDateTime, fmtUsd, pnlClass, shortHash, txUrl } from "@/lib/format";

type BottomTab = "orders" | "fills" | "balances";

const TABS: TabItem<BottomTab>[] = [
  { value: "orders", label: "Open orders" },
  { value: "fills", label: "Fills" },
  { value: "balances", label: "Balances" },
];

/** Open orders, fills and balances. Mock data until the wallet is connected to Flash. */
export function BottomPanel({ activity }: { activity: TradingActivity }) {
  const [tab, setTab] = useState<BottomTab>("orders");
  const toast = useToast();
  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-panel" aria-label="Account activity">
      <div className="px-3">
        <Tabs value={tab} items={TABS} onChange={setTab} className="border-b-0" />
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
              {activity.openOrders.length === 0 ? <EmptyRow colSpan={8}>No open orders.</EmptyRow> : null}
              {activity.openOrders.map((o) => (
                <TR key={o.id}>
                  <TD className="text-muted">{fmtDateTime(o.ts)}</TD>
                  <TD>{o.asset}</TD>
                  <TD className={o.side === "buy" ? "text-long" : "text-short"}>{o.side}</TD>
                  <TD>{o.orderType}</TD>
                  <TD align="right">{fmtUsd(o.sizeUsd)}</TD>
                  <TD align="right">{fmtAmount(o.priceUsd, 2)}</TD>
                  <TD className="text-muted">{o.status.replace("_", " ")}</TD>
                  <TD align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toast({ title: "Cancel coming soon", description: "Needs a signed Flash cancel." })}
                    >
                      Cancel
                    </Button>
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
              {activity.fills.length === 0 ? <EmptyRow colSpan={7}>No fills yet.</EmptyRow> : null}
              {activity.fills.map((f) => (
                <TR key={f.id}>
                  <TD className="text-muted">{fmtDateTime(f.ts)}</TD>
                  <TD>{f.asset}</TD>
                  <TD className={f.side === "buy" ? "text-long" : "text-short"}>{f.side}</TD>
                  <TD align="right">{fmtUsd(f.sizeUsd)}</TD>
                  <TD align="right">{fmtAmount(f.priceUsd, 2)}</TD>
                  <TD align="right" className="text-muted">
                    {fmtUsd(f.feeUsd, 4)}
                  </TD>
                  <TD>
                    <a href={txUrl(f.txHash)} target="_blank" rel="noreferrer" className="text-link hover:underline">
                      {shortHash(f.txHash)}
                    </a>
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
              {activity.balances.map((b) => (
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
