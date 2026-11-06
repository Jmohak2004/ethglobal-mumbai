"use client";

import { useQuery } from "@tanstack/react-query";

import { getJson } from "@/lib/api";
import type { PlatformInfo } from "@/lib/types";

/** Public platform settings: execution mode, Flash availability, caps. Cached for a minute. */
export function usePlatform() {
  return useQuery({
    queryKey: ["platform"],
    queryFn: () => getJson<PlatformInfo>("/api/platform"),
    staleTime: 60_000,
  });
}
