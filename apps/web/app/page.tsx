import { Suspense } from "react";

import { LeaderboardControls } from "@/components/leaderboard/leaderboard-controls";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { StatStrip } from "@/components/leaderboard/stat-strip";
import { getLeaderboard, getRisk, parseLeaderboardQuery } from "@/lib/data";

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
    <div className="flex flex-col gap-3 px-4 py-3">
      <StatStrip {...stats} />
      <Suspense fallback={null}>
        <LeaderboardControls />
      </Suspense>
      <LeaderboardTable rows={rows} />
      <p className="text-[11px] text-muted">
        Stats only. Trades, configs and sliders are visible to owners and forkers. Stats are computed by Chainlink CRE from
        Flash fills and signed onchain.
      </p>
    </div>
  );
}
