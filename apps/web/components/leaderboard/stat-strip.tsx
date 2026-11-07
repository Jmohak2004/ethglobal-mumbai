import { RiskPill } from "@/components/layout/risk-pill";
import { StatCard } from "@/components/ui/stat-card";
import { fmtCompactUsd, fmtNum, fmtPct } from "@/lib/format";
import type { RiskLevel } from "@arena/shared";

export function StatStrip({
  agents,
  live,
  paper,
  volume24h,
  verifiedPct,
  risk,
}: {
  agents: number;
  live: number;
  paper: number;
  volume24h: number;
  verifiedPct: number;
  risk: RiskLevel;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="Agents" value={fmtNum(agents)} sub={`${live} live, ${paper} paper`} />
      <StatCard label="24h volume" value={fmtCompactUsd(volume24h)} sub="Agents and humans together" />
      <StatCard
        label="Verified"
        value={fmtPct(verifiedPct, 0)}
        sub="Agents with a signed report"
        help="Share of agents whose results were re-checked and signed onchain by Chainlink CRE."
      />
      <StatCard
        label="Market safety light"
        value={<RiskPill level={risk} />}
        sub="Agents pause buying if it turns red"
      />
    </div>
  );
}
