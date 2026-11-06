"use client";

import type { ReactNode } from "react";

import { Pill } from "@/components/ui/pill";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { fmtCountdown, outcomeTone } from "@/lib/runtime";
import { useAgentRuntime, useNow } from "@/lib/hooks/use-agent-runtime";

/**
 * Compact status strip under the agent header. Public and owner: provisioning, last and next decision, and a
 * worker-offline warning. The owner also sees the last error. Polls every 5 s.
 */
export function AgentStatusStrip({ agentId, demo }: { agentId: string; demo: boolean }) {
  const rt = useAgentRuntime(agentId, demo);
  const now = useNow(1_000);

  if (rt.isPending) {
    return <div className="h-9 animate-pulse rounded-md border border-border bg-panel" aria-hidden />;
  }
  if (rt.isError || !rt.data) {
    return (
      <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] text-muted">
        Agent status unavailable right now.
      </div>
    );
  }

  const v = rt.data;
  // Server clock at the local `now`: serverNow was read when the response was built (at rt.dataUpdatedAt locally).
  const serverNowAtNow = now + (v.serverNow - rt.dataUpdatedAt);
  const remainingMs = v.nextTickAt !== null ? v.nextTickAt - serverNowAtNow : null;

  return (
    <div
      role="status"
      aria-label="Agent status"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-panel px-3 py-2 text-[12px]"
    >
      <Item label="Wallet">
        {v.walletProvisioned ? (
          <span className="text-long">✓ provisioned</span>
        ) : (
          <span className="text-warn">pending</span>
        )}
      </Item>

      <Item label="Last decision">
        {v.lastTickAt !== null ? (
          <span className="flex items-center gap-2">
            <span className="num text-text" title={fmtDateTime(v.lastTickAt)}>
              {fmtAgo(v.lastTickAt, serverNowAtNow)}
            </span>
            {v.lastOutcome ? <Pill tone={outcomeTone(v.lastOutcome)}>{v.lastOutcome}</Pill> : null}
          </span>
        ) : (
          <span className="text-muted">none yet</span>
        )}
      </Item>

      <Item label="Next decision">
        {remainingMs === null ? (
          <span className="text-muted">not scheduled</span>
        ) : remainingMs <= 0 ? (
          <span className="num text-text">due now</span>
        ) : (
          <span className="num text-text">in {fmtCountdown(remainingMs)}</span>
        )}
      </Item>

      {v.viewer === "owner" && v.lastError ? (
        <Item label="Last error">
          <span className="max-w-[28rem] truncate text-short" title={v.lastError}>
            {v.lastError}
          </span>
        </Item>
      ) : null}

      {v.workerOffline ? (
        <Tooltip
          side="bottom"
          content={
            <div className="flex max-w-[16rem] flex-col gap-0.5">
              <div className="font-medium">No recent worker update</div>
              <div className="text-muted">
                The status is missing or older than twice the tick interval. Check that the worker is running.
              </div>
            </div>
          }
        >
          <Pill tone="warn">Worker offline?</Pill>
        </Tooltip>
      ) : null}
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}
