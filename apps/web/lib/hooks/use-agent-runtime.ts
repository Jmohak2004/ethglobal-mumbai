"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getJson } from "@/lib/api";
import type { AgentRuntimeView } from "@/lib/types";

/**
 * Runtime status for one agent, polled every 5 s. The status strip and the owner console share this query key, so
 * both read one request. `demo` adds ?owner=1 (the demo owner override, honoured only outside production).
 */
export function useAgentRuntime(agentId: string, demo: boolean) {
  return useQuery({
    queryKey: ["runtime", agentId, demo],
    queryFn: () => getJson<AgentRuntimeView>(`/api/agents/${agentId}/runtime${demo ? "?owner=1" : ""}`),
    refetchInterval: 5_000,
    retry: false,
  });
}

/** The current time in ms, re-rendered every `intervalMs`. For countdowns. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
