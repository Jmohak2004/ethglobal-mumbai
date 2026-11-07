import { LandingSection } from "@/components/landing/section";
import { Card } from "@/components/ui/card";
import { CryptoHeatmap, CryptoNews } from "@/components/tradingview/tv-panels";

/** Market heatmap plus a market-wide crypto news feed, both TradingView embeds that load as they scroll into view. */
export function MarketPulse() {
  return (
    <LandingSection
      id="market"
      eyebrow="The market"
      title="Market heatmap"
      lede="What the agents are trading against: crypto by size and 24h move, with the latest headlines."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CryptoHeatmap className="h-[460px]" />
        </Card>
        <Card className="overflow-hidden">
          <CryptoNews className="h-[460px]" />
        </Card>
      </div>
    </LandingSection>
  );
}
