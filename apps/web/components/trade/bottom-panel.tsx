"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { EmptyRow, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { describeError, getJson, postJson } from "@/lib/api";
import { fmtAmount, fmtDateTime, fmtUsd, pnlClass, shortHash, txUrl } from "@/lib/format";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSession } from "@/lib/hooks/use-session";
import { markPaperOrdersCancelled, usePaperCancelledOrders } from "@/lib/paper-orders";
import { usePaperFills, usePaperServerFills } from "@/lib/paper-fills";
import { cancelFlashOrders } from "@/lib/trade";
import type { Balance, CancelResult, Fill, OpenOrder, TradingActivity } from "@/lib/types";

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
  const qc = useQueryClient();
  const toast = useToast();
  const { signMessageAsync } = useSignMessage();
  const cancelledPaper = usePaperCancelledOrders();
  const [busy, setBusy] = useState<string | null>(null);

  const funder = session.signedIn ? session.address : null;
  // Saved paper fills (database) for the signed-in wallet. The local list only holds fills whose save failed.
  const serverPaper = usePaperServerFills(funder);
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
    fills = [...live.data.fills, ...serverPaper, ...paper];
    balances = live.data.balances;
  } else if (funder) {
    note = "Paper mode: live orders and balances need EXECUTION_MODE=live and a Flash key. Simulated fills are listed below.";
    fills = [...serverPaper, ...paper];
  } else if (address) {
    note = "Sign in with your wallet to load your Flash orders, fills and balances.";
  } else {
    openOrders = activity.openOrders;
    fills = [...paper, ...activity.fills];
    balances = activity.balances;
    note = activity.source === "demo" ? "Demo data. Connect a wallet to see your Flash activity." : null;
  }
  fills = [...fills].sort((a, b) => b.ts - a.ts);

  // Live Flash rows are signed by the funder wallet. Demo and paper rows are only marked cancelled locally.
  const liveOrders = funder !== null && live.data?.live === true;
  const cancellable = openOrders.filter((o) => !cancelledPaper.has(o.id)).map((o) => o.id);

  async function cancelRows(ids: string[], label: string): Promise<void> {
    if (ids.length === 0 || busy !== null) return;
    const markLocal = () => {
      markPaperOrdersCancelled(ids);
      toast({
        title: "Cancelled (simulated)",
        description: `${ids.length} paper order${ids.length === 1 ? "" : "s"} marked cancelled. Nothing was sent to Flash.`,
      });
    };
    if (!liveOrders) {
      markLocal();
      // A signed-in user's paper orders that exist in the database are marked cancelled there too. Nothing goes to Flash.
      if (funder !== null) {
        try {
          await postJson("/api/paper/orders/cancel", { orderIds: ids });
        } catch {
          // Not saved (for example the database is unavailable). The local mark above still applies for this page.
        }
      }
      return;
    }
    setBusy(label);
    try {
      const results = await cancelFlashOrders(ids, (message) => signMessageAsync({ message }));
      if (results === null) {
        markLocal();
        return;
      }
      // PENDING_CANCEL means a cancel is already in flight, so it counts as cancelled. The refetch below confirms it.
      const settled = (r: CancelResult) => r.ok || r.errorCode === "PENDING_CANCEL";
      const failed = results.filter((r) => !settled(r));
      const done = results.length - failed.length;
      toast({
        title: failed.length === 0 ? `Cancelled ${done} order${done === 1 ? "" : "s"}` : `Cancelled ${done} of ${results.length}`,
        description: failed.map((r) => `${r.orderId.slice(0, 8)}: ${r.errorCode ?? "not cancelled"}`).join("; ") || undefined,
        tone: failed.length === 0 ? "success" : "error",
      });
    } catch (err) {
      toast({ title: "Cancel not completed", description: describeError(err), tone: "error" });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ["flash-activity", funder] });
    }
  }

  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]" aria-label="Account activity">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4">
        <Tabs label="Account activity" value={tab} items={TABS} onChange={setTab} className="border-b-0" />
        {note ? <span className="max-w-md truncate text-xs text-muted" title={note}>{note}</span> : null}
      </div>
      <div className="overflow-x-auto border-t border-border">
        {tab === "orders" ? (
          <div className="flex items-center justify-end gap-3 px-4 py-2">
            {busy ? <span className="mr-auto text-xs text-muted">{busy}...</span> : null}
            {liveOrders ? null : <span className="mr-auto text-xs text-muted">Paper orders: cancels are simulated.</span>}
            <Button size="sm" disabled={busy !== null || cancellable.length === 0} onClick={() => cancelRows(cancellable, "Cancelling all")}>
              {liveOrders ? "Cancel all" : "Cancel all (simulated)"}
              {cancellable.length > 0 ? ` (${cancellable.length})` : ""}
            </Button>
          </div>
        ) : null}
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
              {openOrders.length === 0 ? <EmptyRow colSpan={8}>No open orders. Orders you place will show up here.</EmptyRow> : null}
              {openOrders.map((o) => {
                const cancelled = cancelledPaper.has(o.id);
                return (
                  <TR key={o.id}>
                    <TD className="num text-muted">{fmtDateTime(o.ts)}</TD>
                    <TD>{o.asset}</TD>
                    <TD className={o.side === "buy" ? "text-long" : "text-short"}>{o.side}</TD>
                    <TD>{o.orderType}</TD>
                    <TD align="right">{fmtUsd(o.sizeUsd)}</TD>
                    <TD align="right">{fmtAmount(o.priceUsd, 2)}</TD>
                    <TD className="text-muted">
                      {cancelled ? <Badge tone="warn">cancelled (simulated)</Badge> : o.status.replace("_", " ")}
                    </TD>
                    <TD align="right">
                      {cancelled ? null : (
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => cancelRows([o.id], `Cancelling ${o.id.slice(0, 8)}`)}
                          title={
                            liveOrders
                              ? "Your wallet signs a cancel message. Nothing is sent until you sign."
                              : "Paper order: marked cancelled locally. Nothing is sent to Flash."
                          }
                        >
                          {liveOrders ? "Cancel" : "Cancel (simulated)"}
                        </Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
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
              {fills.length === 0 ? <EmptyRow colSpan={7}>No fills yet. Completed trades will show up here.</EmptyRow> : null}
              {fills.map((f) => (
                <TR key={f.id}>
                  <TD className="num text-muted">{f.ts ? fmtDateTime(f.ts) : "-"}</TD>
                  <TD>{f.asset}</TD>
                  <TD className={f.side === "buy" ? "text-long" : "text-short"}>{f.side}</TD>
                  <TD align="right">{fmtUsd(f.sizeUsd)}</TD>
                  <TD align="right">{fmtAmount(f.priceUsd, 2)}</TD>
                  <TD align="right" className="text-muted">
                    {fmtUsd(f.feeUsd, 4)}
                  </TD>
                  <TD>
                    {f.txHash ? (
                      <a href={txUrl(f.txHash)} target="_blank" rel="noreferrer" className="text-accent-fg hover:underline">
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
