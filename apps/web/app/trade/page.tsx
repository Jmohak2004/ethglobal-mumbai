import { BASE_TOKENS } from "@arena/shared";

import { TradeTerminal } from "@/components/trade/trade-terminal";
import { getTradingActivity } from "@/lib/data";
import { loadMarket } from "@/lib/server/market";
import { softRead } from "@/lib/server/soft";
import { ASSET_ALLOWLIST } from "@/lib/templates";
import type { MarketResponse } from "@/lib/types";

export const metadata = { title: "Trade" };

export default async function TradePage() {
  // First paint uses server-fetched candles. The client polls /api/market every 15 s after that. A market outage
  // renders the terminal with a loading state, not an error page.
  const [markets, activity] = await Promise.all([
    Promise.all(ASSET_ALLOWLIST.map((asset) => softRead<MarketResponse | null>(`market ${asset}`, () => loadMarket(asset), null))),
    getTradingActivity(),
  ]);
  const initialMarkets: Record<string, MarketResponse | null> = Object.fromEntries(
    ASSET_ALLOWLIST.map((asset, i) => [asset, markets[i] ?? null]),
  );
  // Chainlink TOKEN/USD feeds on Base, used as the mark-price reference.
  const feeds: Record<string, string | null> = {
    WETH: BASE_TOKENS.WETH?.usdFeed ?? null,
    cbBTC: BASE_TOKENS.cbBTC?.usdFeed ?? null,
  };
  return <TradeTerminal initialMarkets={initialMarkets} activity={activity} feeds={feeds} />;
}
