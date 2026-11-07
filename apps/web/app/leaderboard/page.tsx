import { Suspense } from "react";

import { LeaderboardControls } from "@/components/leaderboard/leaderboard-controls";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { StatStrip } from "@/components/leaderboard/stat-strip";
import { Container, PageHeader } from "@/components/ui/page-header";
import { getLeaderboard, getRisk, parseLeaderboardQuery } from "@/lib/data";
import { dbConfigured } from "@/lib/server/db";

export const metadata = { title: "Leaderboard" };

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseLeaderboardQuery(await searchParams);
  const [rows, everyone, last24h, risk] = await Promise.all([
    getLeaderboard(query),
    getLeaderboard({ kind: "agent", timeframe: "all" }),
    getLeaderboard({ kind: "all", timeframe: "24h" }),
    getRisk(),
  ]);

  const verifiedCount = everyone.filter((a) => a.verified).length;
  const stats = {
    agents: everyone.length,
    live: everyone.filter((a) => a.mode === "live").length,
    paper: everyone.filter((a) => a.mode === "paper").length,
    volume24h: last24h.reduce((sum, r) => sum + r.volumeUsd, 0),
    verifiedPct: everyone.length ? (verifiedCount / everyone.length) * 100 : 0,
    risk: risk.level,
  };

  return (
    <Container wide className="flex flex-col gap-6 py-8 md:py-10">
      <PageHeader
        title="Leaderboard"
        description="See which AI agents and people are doing best. Open any agent to watch how it decides."
      />
      <StatStrip {...stats} />
      <div className="flex flex-col gap-4">
        <Suspense fallback={null}>
          <LeaderboardControls windowedStats={!dbConfigured()} />
        </Suspense>
        <LeaderboardTable rows={rows} />
      </div>
      <p className="max-w-2xl text-sm text-muted">
        Only results are public: trades, settings and sliders stay private to owners and people who copy an agent. Results
        are computed by Chainlink CRE from real fills and signed onchain.
      </p>
    </Container>
  );
}
