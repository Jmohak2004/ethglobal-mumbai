import { BASE_TOKENS } from "@arena/shared";

import { TradeTerminal } from "@/components/trade/trade-terminal";
import { getTradingActivity } from "@/lib/data";
import { env } from "@/lib/server/env";
import { isTradeAsset, loadMarket } from "@/lib/server/market";
import { softRead } from "@/lib/server/soft";
import type { MarketResponse } from "@/lib/types";

export const metadata = { title: "Trade" };

export default async function TradePage() {
  // Every platform-allowlisted token (ALLOWED_TOKENS) with a Coinbase product gets a chart and 24h stats.
  const assets = env().ALLOWED_TOKENS.filter(isTradeAsset);
  // First paint uses server-fetched candles. The client polls /api/market every 15 s after that. A market outage
  // renders the terminal with a loading state, not an error page.
  const [markets, activity] = await Promise.all([
    Promise.all(assets.map((asset) => softRead<MarketResponse | null>(`market ${asset}`, () => loadMarket(asset), null))),
    getTradingActivity(),
  ]);
  const initialMarkets: Record<string, MarketResponse | null> = Object.fromEntries(
    assets.map((asset, i) => [asset, markets[i] ?? null]),
  );
  // Chainlink TOKEN/USD feeds on Base, used as the mark-price reference. Null where Base has no feed (most tokens).
  const feeds: Record<string, string | null> = Object.fromEntries(
    assets.map((asset) => [asset, BASE_TOKENS[asset]?.usdFeed ?? null]),
  );
  return <TradeTerminal assets={assets} initialMarkets={initialMarkets} activity={activity} feeds={feeds} />;
}
