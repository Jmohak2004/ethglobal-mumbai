"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus } from "@arena/shared";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconPlay } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { describeError, postJson } from "@/lib/api";
import type { AgentRuntimeView } from "@/lib/types";

/** Give up waiting for the worker after this long and say so (the server request stays queued). */
const WAIT_LIMIT_MS = 180_000;

/**
 * Owner "Run now". Queues one tick (POST /api/agents/[id]/tick). The button reads "queued…" until the worker has
 * run the tick, which shows as runtime.lastTickAt moving past the value seen when the run was requested. It is
 * also disabled while the server reports a queued request (survives a page reload).
 */
export function RunNowButton({
  agentId,
  status,
  demo,
  runtime,
}: {
  agentId: string;
  status: AgentStatus;
  demo: boolean;
  runtime: AgentRuntimeView | undefined;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState<{ startedAt: number; lastTickAt: number | null } | null>(null);

  const lastTickAt = runtime?.lastTickAt ?? null;
  const done = waiting !== null && lastTickAt !== null && lastTickAt > (waiting.lastTickAt ?? 0);
  const queued = !done && (waiting !== null || runtime?.tickQueued === true);

  // Stop waiting after the limit. The server request stays queued, so the button's disabled state follows it.
  // The timer is cleared as soon as the tick lands (done), so a finished run never reports as still queued.
  useEffect(() => {
    if (!waiting || done) return;
    const timer = setTimeout(() => {
      setWaiting(null);
      toast({
        title: "Still queued",
        description: "The worker has not run the decision yet. Check the worker status above.",
        tone: "error",
      });
    }, WAIT_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [waiting, done, toast]);

  const run = useMutation({
    mutationFn: () => postJson<{ requestId: string; queued: boolean }>(`/api/agents/${agentId}/tick${demo ? "?owner=1" : ""}`, {}),
    onError: (err) => toast({ title: "Run not queued", description: describeError(err), tone: "error" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["runtime", agentId] }),
  });

  const click = () => {
    const at = lastTickAt;
    run.mutate(undefined, {
      onSuccess: () => {
        setWaiting({ startedAt: Date.now(), lastTickAt: at });
        toast({ title: "Run queued", description: "The worker picks it up within a few seconds." });
      },
    });
  };

  const label = run.isPending ? "Queuing…" : queued ? "Queued…" : "Run now";
  const reason =
    status === "active" ? undefined : status === "paused" ? "Resume the agent to run a decision" : "A stopped agent cannot run";

  return (
    <Button
      variant="primary"
      disabled={status !== "active" || run.isPending || queued}
      title={reason ?? "Queue one decision now (paper or live, as configured)"}
      onClick={click}
    >
      <IconPlay size={13} />
      {label}
    </Button>
  );
}
