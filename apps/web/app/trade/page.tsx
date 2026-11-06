import { BASE_TOKENS, type MarketSnapshot } from "@arena/shared";

import { TradeTerminal } from "@/components/trade/trade-terminal";
import { getMarket, getTradingActivity } from "@/lib/data";

export const metadata = { title: "Trade" };

export default async function TradePage() {
  const [weth, cbbtc, activity] = await Promise.all([getMarket("WETH"), getMarket("cbBTC"), getTradingActivity()]);
  const markets = [weth, cbbtc].filter((m): m is MarketSnapshot => m !== null);
  // Chainlink TOKEN/USD feeds on Base, used as the mark-price reference.
  const feeds: Record<string, string | null> = {
    WETH: BASE_TOKENS.WETH?.usdFeed ?? null,
    cbBTC: BASE_TOKENS.cbBTC?.usdFeed ?? null,
  };
  return <TradeTerminal markets={markets} activity={activity} feeds={feeds} />;
}
