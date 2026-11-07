import { BASE_TOKENS, COINBASE_PRODUCTS } from "@arena/shared";

import { TradeTerminal } from "@/components/trade/trade-terminal";
import { getTradingActivity } from "@/lib/data";
import { intervalFromLabel } from "@/lib/live/intervals";
import { loadMarket, tradeAssets } from "@/lib/server/market";
import { softRead } from "@/lib/server/soft";
import type { MarketResponse } from "@/lib/types";

export const metadata = { title: "Trade" };

/** /trade?asset=LINK&interval=1h. Unknown or missing values fall back to the first market and 5m. */
export default async function TradePage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string; interval?: string }>;
}) {
  const sp = await searchParams;
  // Every platform-allowlisted token (ALLOWED_TOKENS) with a Coinbase product is tradable on this page.
  const assets = tradeAssets();
  const requested = sp.asset?.toLowerCase();
  const asset = assets.find((a) => a.toLowerCase() === requested) ?? assets[0] ?? "WETH";
  const granularity = intervalFromLabel(sp.interval);

  // Only the selected market's candles render on the server. The markets list and the live feed take over on the
  // client. A market outage renders the terminal with a loading state, not an error page.
  const [market, activity] = await Promise.all([
    softRead<MarketResponse | null>(`market ${asset}`, () => loadMarket(asset, granularity), null),
    getTradingActivity(),
  ]);
  const products: Record<string, string> = Object.fromEntries(
    assets.map((a) => [a, COINBASE_PRODUCTS[a] ?? a]),
  );
  // Chainlink TOKEN/USD feeds on Base, shown as a reference in the header. Null where Base has no feed (most tokens).
  const feeds: Record<string, string | null> = Object.fromEntries(
    assets.map((asset) => [asset, BASE_TOKENS[asset]?.usdFeed ?? null]),
  );
  return (
    <TradeTerminal
      assets={assets}
      products={products}
      feeds={feeds}
      initial={{ asset, granularity, market }}
      activity={activity}
    />
  );
}
