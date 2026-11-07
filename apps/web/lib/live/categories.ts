// Display categories for the markets list. Assets outside this map show as "Other".

export const CATEGORY_ORDER = ["Majors", "DeFi", "AI & social", "Memes", "Stable", "Other"] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_BY_ASSET: Record<string, Category> = {
  WETH: "Majors",
  cbBTC: "Majors",
  cbETH: "Majors",
  cbXRP: "Majors",
  cbDOGE: "Majors",
  cbLTC: "Majors",
  LINK: "Majors",
  UNI: "Majors",
  AERO: "DeFi",
  MORPHO: "DeFi",
  COMP: "DeFi",
  SNX: "DeFi",
  WELL: "DeFi",
  VIRTUAL: "AI & social",
  KAITO: "AI & social",
  ZORA: "AI & social",
  PRIME: "AI & social",
  DEGEN: "Memes",
  TOSHI: "Memes",
  EURC: "Stable",
};

export function categoryOf(asset: string): Category {
  return CATEGORY_BY_ASSET[asset] ?? "Other";
}
