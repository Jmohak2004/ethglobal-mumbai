// Live marks for unrealized PnL. One price lookup per distinct asset per stats pass, shared by every entity in the
// pass. A failed lookup leaves the asset unmarked (computeFifoPnl then counts 0 for it); it never throws.

import type { MarketData } from "./deps.ts";
import { silentLogger, type Logger } from "./logger.ts";

export interface MarkSource {
  /** USD price per asset. Assets whose price lookup failed are absent. */
  marksFor(assets: string[]): Promise<Record<string, number>>;
}

/** Creates a per-pass cache over market.getPrice. Create a new one for each pass so prices are never stale. */
export function createMarkSource(market: Pick<MarketData, "getPrice"> | undefined, logger: Logger = silentLogger): MarkSource {
  const lookups = new Map<string, Promise<number | null>>();

  const price = (asset: string): Promise<number | null> => {
    let p = lookups.get(asset);
    if (!p) {
      p = (async () => {
        try {
          const v = await market!.getPrice(asset);
          return Number.isFinite(v) && v > 0 ? v : null;
        } catch (err) {
          logger.warn("mark price unavailable; open lots left unmarked", { asset, error: err });
          return null;
        }
      })();
      lookups.set(asset, p);
    }
    return p;
  };

  return {
    async marksFor(assets) {
      const marks: Record<string, number> = {};
      if (!market) return marks;
      await Promise.all(
        [...new Set(assets)].map(async (asset) => {
          const v = await price(asset);
          if (v !== null) marks[asset] = v;
        }),
      );
      return marks;
    },
  };
}
