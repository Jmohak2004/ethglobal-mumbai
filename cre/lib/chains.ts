// Chain, feed and forwarder constants used by the CRE workflows.
// Copied from packages/shared/src/chains.ts (CRE workflows compile separately and cannot import workspace packages).
// Keep in sync with the monorepo copy when addresses change.

/** CRE chain-selector names (see the CRE EVM client SUPPORTED_CHAIN_SELECTORS list). */
export const CHAIN_SELECTOR_NAMES = {
  baseSepolia: "ethereum-testnet-sepolia-base-1",
  base: "ethereum-mainnet-base-1",
} as const;

/** CRE KeystoneForwarder addresses (CRE forwarder directory). */
export const CRE_FORWARDERS = {
  base: {
    /** MockKeystoneForwarder: only for `cre workflow simulate --broadcast`. */
    simulation: "0x5e342a8438b4f5d39e72875fcee6f76b39cce548",
    /** KeystoneForwarder: what deployed receivers must accept. */
    production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
  },
  baseSepolia: {
    simulation: "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5",
    production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
  },
} as const;

/** Chainlink Data Feeds per chain. The shared package marks Base mainnet feeds VERIFY; re-check before mainnet use. */
export const DATA_FEEDS = {
  baseSepolia: {
    ETH_USD: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    BTC_USD: "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298",
  },
  base: {
    ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // VERIFY
    BTC_USD: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", // VERIFY
  },
} as const;

/** Decimals of tokens Flash trades on Base (used to convert Flash decimal strings to base units). */
export const ASSET_DECIMALS: Readonly<Record<string, number>> = {
  USDC: 6,
  WETH: 18,
  cbBTC: 8,
};

/** Trading asset ticker -> the USD price feed used to mark it. */
export const ASSET_MARK_FEED: Readonly<Record<string, "ETH_USD" | "BTC_USD">> = {
  WETH: "ETH_USD",
  cbBTC: "BTC_USD",
};

export const FLASH_API_URL = "https://flash.definitive.fi/v1";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
