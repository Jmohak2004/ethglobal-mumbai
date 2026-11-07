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
  cbETH: { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, usdFeed: null },
  MORPHO: { symbol: "MORPHO", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", decimals: 18, usdFeed: null },
  LINK: { symbol: "LINK", address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", decimals: 18, usdFeed: null },
  UNI: { symbol: "UNI", address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83", decimals: 18, usdFeed: null },
  COMP: { symbol: "COMP", address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0", decimals: 18, usdFeed: null },
  SNX: { symbol: "SNX", address: "0x22e6966B799c4D5B13BE962E1D117b56327FDa66", decimals: 18, usdFeed: null },
  cbDOGE: { symbol: "cbDOGE", address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510", decimals: 8, usdFeed: null },
  cbXRP: { symbol: "cbXRP", address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af", decimals: 6, usdFeed: null },
  PRIME: { symbol: "PRIME", address: "0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b", decimals: 18, usdFeed: null },
  KAITO: { symbol: "KAITO", address: "0x98d0baa52b2D063E780DE12F615f963Fe8537553", decimals: 18, usdFeed: null },
  EURC: { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6, usdFeed: null },
  cbLTC: { symbol: "cbLTC", address: "0xcb17C9Db87B595717C857a08468793f5bAb6445F", decimals: 8, usdFeed: null },
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
  cbETH: "CBETH-USD",
  MORPHO: "MORPHO-USD",
  LINK: "LINK-USD",
  UNI: "UNI-USD",
  COMP: "COMP-USD",
  SNX: "SNX-USD",
  cbDOGE: "DOGE-USD",
  cbXRP: "XRP-USD",
  PRIME: "PRIME-USD",
  KAITO: "KAITO-USD",
  EURC: "EURC-USD",
  cbLTC: "LTC-USD",
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
