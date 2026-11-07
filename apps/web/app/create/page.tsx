import { CreateWizard } from "@/components/create/create-wizard";
import { Container, PageHeader } from "@/components/ui/page-header";
import { getLeaderboard } from "@/lib/data";

export const metadata = { title: "Create agent" };

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const sp = await searchParams;
  const board = await getLeaderboard({ kind: "agent", timeframe: "all" });
  const agents = board.map((s) => ({ id: s.entityId, name: s.name }));
  return (
    <Container narrow className="flex flex-col gap-6 py-8 md:py-10">
      <PageHeader title="Create an agent" description="Three quick steps. Paper mode is the default, so nothing here risks real money." />
      <CreateWizard agents={agents} demo={sp.owner === "1"} />
    </Container>
  );
}
