// Deployed contract addresses and chain, from NEXT_PUBLIC_* (public values only). Client-safe.
// Missing addresses mean "not deployed": UI buttons show that state instead of failing.
import { base, baseSepolia } from "viem/chains";

const asAddress = (v: string | undefined): `0x${string}` | null =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null;

export const CHAIN = process.env.NEXT_PUBLIC_CHAIN === "baseSepolia" ? baseSepolia : base;

export const CONTRACTS = {
  marketplace: asAddress(process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS),
  treasury: asAddress(process.env.NEXT_PUBLIC_TREASURY_ADDRESS),
  usdc:
    asAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS) ??
    (CHAIN.id === baseSepolia.id
      ? ("0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const)
      : ("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const)),
};

export const USDC_DECIMALS = 6;
