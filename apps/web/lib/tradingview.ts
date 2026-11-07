/**
 * TradingView embed helpers. Every base ticker below was checked against TradingView's symbol search
 * (exchange COINBASE, <BASE>USD). Tradable assets Coinbase lists but TradingView has no COINBASE:<X>USD pair for
 * (EURC) are simply absent, so widgets never show "invalid symbol".
 */

/** Tickers shown in the ticker tape, in display order. */
export const TV_TICKERS = [
  "ETH", "BTC", "AERO", "VIRTUAL", "DEGEN", "TOSHI", "WELL", "ZORA", "MORPHO", "LINK", "UNI",
  "CLANKER", "PROMPT", "KEYCAT", "COOKIE", "B3", "BNKR", "AVNT", "KAITO", "DOGE", "XRP",
] as const;

/** Every base ticker TradingView resolves on Coinbase (the tape list plus the other tradable assets). */
const TV_KNOWN = new Set<string>([...TV_TICKERS, "CBETH", "COMP", "SNX", "PRIME", "LTC"]);

export const TV_TAPE_SYMBOLS = TV_TICKERS.map((t) => ({ proName: `COINBASE:${t}USD`, title: t }));

/** "ETH-USD" (a Coinbase product) -> "COINBASE:ETHUSD", or null when TradingView does not list it. */
export function tvSymbolForProduct(product: string | null | undefined): string | null {
  const base = product?.split("-")[0]?.toUpperCase();
  return base && TV_KNOWN.has(base) ? `COINBASE:${base}USD` : null;
}
