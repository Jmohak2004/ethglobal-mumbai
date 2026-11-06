import type { PerformanceStats } from "@arena/shared";
import { connection } from "next/server";

import { ClosingCta } from "@/components/landing/closing-cta";
import { Faq } from "@/components/landing/faq";
import { GetStarted } from "@/components/landing/get-started";
import { PoweredBy, WhatYouCanDo } from "@/components/landing/features";
import { Hero, type LiveStats } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Safety } from "@/components/landing/safety";
import { getLeaderboard, getRisk } from "@/lib/data";
import { softRead } from "@/lib/server/soft";
import type { RiskDisplay } from "@/lib/types";

export const metadata = { title: "AI trading agents you can verify" };

// Agent counts and the crash light come from the database. A failed read falls back to "n/a" and UNKNOWN, never a 500.
async function loadLiveStats(): Promise<LiveStats | null> {
  return softRead<LiveStats | null>(
    "landing live stats",
    async () => {
      const rows: PerformanceStats[] = await getLeaderboard({ kind: "agent", timeframe: "all" });
      const verified = rows.filter((r) => r.verified).length;
      return {
        agents: rows.length,
        live: rows.filter((r) => r.mode === "live").length,
        paper: rows.filter((r) => r.mode === "paper").length,
        verifiedPct: rows.length ? (verified / rows.length) * 100 : 0,
      };
    },
    null,
  );
}

async function loadRisk(): Promise<RiskDisplay> {
  return softRead<RiskDisplay>("landing risk", async () => (await getRisk()).level, "UNKNOWN");
}

export default async function LandingPage() {
  // Read live numbers per request, not from a build-time snapshot.
  await connection();
  const [live, risk] = await Promise.all([loadLiveStats(), loadRisk()]);

  return (
    <>
      <Hero live={live} risk={risk} />
      <HowItWorks />
      <GetStarted />
      <WhatYouCanDo />
      <Safety />
      <PoweredBy />
      <Faq />
      <ClosingCta />
    </>
  );
}
