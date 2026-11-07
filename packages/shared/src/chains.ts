// Chain + token registry. Addresses marked VERIFY must be checked against official docs before mainnet use.

export const CHAIN_IDS = {
  base: 8453,
  baseSepolia: 84532,
  zgMainnet: 16661,
  zgGalileo: 16602,
} as const;

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Chainlink Data Feed (TOKEN/USD) on the same chain, if one exists. */
  usdFeed: `0x${string}` | null;
}

/** Base mainnet: where Flash trades and where demo contracts are deployed. Flash addresses are mainnet only. */
export const BASE_TOKENS: Record<string, TokenInfo> = {
  USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, usdFeed: null },
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, usdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" }, // VERIFY feed
  cbBTC: { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, usdFeed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" }, // VERIFY feed (BTC/USD)
  AERO: { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, usdFeed: null },
  VIRTUAL: { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", decimals: 18, usdFeed: null },
  DEGEN: { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18, usdFeed: null },
  TOSHI: { symbol: "TOSHI", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", decimals: 18, usdFeed: null },
  WELL: { symbol: "WELL", address: "0xA88594D404727625A9437C3f886C7643872296AE", decimals: 18, usdFeed: null },
  ZORA: { symbol: "ZORA", address: "0x1111111111166b7FE7bd91427724B487980aFc69", decimals: 18, usdFeed: null },
};

/**
 * Coinbase Exchange product for each tradable ticker. The single source for candles (worker and web) and for the
 * last-price mark on assets with no Chainlink feed. Every ticker here must also be in BASE_TOKENS.
 */
export const COINBASE_PRODUCTS: Record<string, string> = {
  WETH: "ETH-USD",
  cbBTC: "BTC-USD",
  AERO: "AERO-USD",
  VIRTUAL: "VIRTUAL-USD",
  DEGEN: "DEGEN-USD",
  TOSHI: "TOSHI-USD",
  WELL: "WELL-USD",
  ZORA: "ZORA-USD",
};

/** Base Sepolia: development target for contracts and CRE simulations. */
export const BASE_SEPOLIA_TOKENS: Record<string, TokenInfo> = {
  USDC: { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, usdFeed: null },
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, usdFeed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1" },
  cbBTC: { symbol: "cbBTC", address: "0x0000000000000000000000000000000000000000", decimals: 8, usdFeed: "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298" },
};

/** CRE KeystoneForwarder addresses (CRE forwarder directory). */
export const CRE_FORWARDERS = {
  base: { simulation: "0x5e342a8438b4f5d39e72875fcee6f76b39cce548", production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" },
  baseSepolia: { simulation: "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5", production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" },
} as const;

/** 0G Payment Layer (compute credit) contracts. */
export const ZG_PAYMENT_LAYER = {
  mainnet: "0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32",
  testnet: "0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939",
} as const;

export const ZG_ROUTER_URL = {
  mainnet: "https://router-api.0g.ai/v1",
  testnet: "https://router-api-testnet.integratenetwork.work/v1",
} as const;

export const FLASH_API_URL = "https://flash.definitive.fi/v1";
export const FLASH_WS_URL = "wss://flash.definitive.fi/v1/ws";
