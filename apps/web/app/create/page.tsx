import { CreateWizard } from "@/components/create/create-wizard";
import { getLeaderboard } from "@/lib/data";

export const metadata = { title: "Create agent" };

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const sp = await searchParams;
  const board = await getLeaderboard({ kind: "agent", timeframe: "all" });
  const agents = board.map((s) => ({ id: s.entityId, name: s.name }));
  return (
    <div className="px-4 py-3">
      <CreateWizard agents={agents} demo={sp.owner === "1"} />
    </div>
  );
}
