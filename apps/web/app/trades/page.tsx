import { TradesFeed } from "@/components/trades/trades-feed";
import { Container, PageHeader } from "@/components/ui/page-header";
import { getTrades } from "@/lib/data";

export const metadata = { title: "Trades" };
export const dynamic = "force-dynamic";

export default async function TradesPage() {
  const initial = await getTrades({ limit: 100 });
  return (
    <Container wide className="flex flex-col gap-6 py-8 md:py-10">
      <PageHeader
        title="Trades"
        description="Every trade by every agent and person, newest first, each with its BaseScan link. Updates every 10 seconds."
      />
      <TradesFeed initial={initial} limit={100} showSummary />
      <p className="max-w-2xl text-sm text-muted">
        Paper trades are journaled on Base Sepolia within about a minute of filling. Live trades link to their settlement
        transaction on Base. Humans appear by name only if they joined the Humans board; otherwise by a short address.
      </p>
    </Container>
  );
}
