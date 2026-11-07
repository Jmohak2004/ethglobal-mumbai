"use client";

import type { AgentStatus } from "@arena/shared";
import type { ReactNode } from "react";

import { StatusControl } from "@/components/agent/owner-section";
import { RunNowButton } from "@/components/agent/run-now-button";
import { Pill, type Tone } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { useAgentRuntime, useNow } from "@/lib/hooks/use-agent-runtime";
import { fmtCountdown, outcomeTone } from "@/lib/runtime";

/** The agent's last outcome (a worker string) in plain words. */
function describeOutcome(outcome: string): string {
  switch (outcome) {
    case "approve":
      return "Placed a trade after the safety check passed";
    case "clamp":
      return "Placed a smaller trade because a safety rule shrank it";
    case "reject":
      return "Wanted to trade, but a safety rule blocked it";
    case "hold":
    case "noop":
      return "Looked at the market and decided to wait";
    case "error":
      return "Ran into a problem and did not trade";
    case "not provisioned":
      return "Cannot trade yet because its wallet is not set up";
    default:
      return outcome;
  }
}

const TONE_LABEL: Record<string, Tone> = { long: "long", short: "short", warn: "warn", muted: "muted" };

/**
 * Summary card at the top of an agent page. Public and owner: status, the last decision in plain words, a countdown to
 * the next one, and a worker-offline warning. The owner also gets Run now, Pause or Resume, and the last error.
 * Polls every 5 s.
 */
export function AgentStatusStrip({ agentId, demo, status }: { agentId: string; demo: boolean; status: AgentStatus }) {
  const rt = useAgentRuntime(agentId, demo);
  const now = useNow(1_000);

  if (rt.isPending) {
    return <Skeleton className="h-28 rounded-xl" />;
  }
  if (rt.isError || !rt.data) {
    return (
      <div className="rounded-xl border border-border bg-panel px-4 py-3 text-base text-muted">
        Live status is unavailable right now. Try again in a moment.
      </div>
    );
  }

  const v = rt.data;
  const owner = v.viewer === "owner";
  // Server clock at the local `now`: serverNow was read when the response was built (at rt.dataUpdatedAt locally).
  const serverNowAtNow = now + (v.serverNow - rt.dataUpdatedAt);
  const remainingMs = v.nextTickAt !== null ? v.nextTickAt - serverNowAtNow : null;

  return (
    <section
      aria-label="Agent status"
      className="flex flex-col gap-4 rounded-xl border border-border bg-panel p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr_1fr]">
        <Item label="Last decision">
          {v.lastTickAt !== null ? (
            <div className="flex flex-col gap-1">
              <span className="text-base font-medium">
                {v.lastOutcome ? describeOutcome(v.lastOutcome) : "Made a decision"}
              </span>
              <span className="flex items-center gap-2 text-sm text-muted">
                <span title={fmtDateTime(v.lastTickAt)}>{fmtAgo(v.lastTickAt, serverNowAtNow)}</span>
                {v.lastOutcome ? <Pill tone={TONE_LABEL[outcomeTone(v.lastOutcome)] ?? "muted"}>{v.lastOutcome}</Pill> : null}
              </span>
            </div>
          ) : (
            <span className="text-base text-muted">Nothing yet. The first decision appears after the agent runs.</span>
          )}
        </Item>

        <Item label="Next decision">
          {remainingMs === null ? (
            <span className="text-base text-muted">{status === "active" ? "Not scheduled yet" : "Paused, so none scheduled"}</span>
          ) : remainingMs <= 0 ? (
            <span className="text-base font-medium">Due now</span>
          ) : (
            <span className="num text-xl font-medium" aria-label={`In ${fmtCountdown(remainingMs)}`}>
              {fmtCountdown(remainingMs)}
            </span>
          )}
        </Item>

        <Item label="Trading wallet">
          {v.walletProvisioned ? (
            <Pill tone="long">Ready</Pill>
          ) : (
            <Tooltip content="The agent's trading wallet is still being set up. It cannot trade until then.">
              <Pill tone="warn">Setting up</Pill>
            </Tooltip>
          )}
        </Item>
      </div>

      {owner ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <RunNowButton agentId={agentId} status={status} demo={demo} runtime={v} />
          <StatusControl agentId={agentId} status={status} demo={demo} />
          <span className="text-sm text-muted">Only you see these controls.</span>
        </div>
      ) : null}

      {owner && v.lastError ? (
        <div className="rounded-lg bg-short-soft px-3 py-2 text-sm text-short">
          <span className="font-medium">Last error: </span>
          <span className="break-words">{v.lastError}</span>
        </div>
      ) : null}

      {v.workerOffline ? (
        <div className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          <span className="font-medium">The agent runner looks offline.</span>
          <span className="text-warn/90">
            Its status is missing or older than twice its decision interval, so it may not be running.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}
