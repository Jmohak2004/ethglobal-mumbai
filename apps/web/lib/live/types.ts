// Wire types shared by the server (GET /api/markets) and the live client. Pure: safe to import from both sides.

/** 24h stats for one platform asset, from Coinbase /products/{id}/stats. */
export interface MarketStats {
  asset: string;
  product: string;
  priceUsd: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24hPct: number;
  /** When the upstream stats were fetched (server clock, ms). */
  ts: number;
}

export interface MarketsResponse {
  ts: number;
  markets: MarketStats[];
  /** Platform assets with no usable upstream stats right now (e.g. a delisted Coinbase product). */
  unavailable: string[];
}
