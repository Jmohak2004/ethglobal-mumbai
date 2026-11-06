import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { base, baseSepolia } from "wagmi/chains";

// Placeholder keeps the wallet modal usable without a WalletConnect Cloud id (relay may be rate-limited).
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "arena-placeholder-wc-project-id";

export const wagmiConfig = getDefaultConfig({
  appName: "ARENA",
  projectId,
  chains: [base, baseSepolia],
  // Explicit list. The default set includes Base Account, whose SDK chain (@coinbase/cdp-sdk, @x402/*)
  // does not bundle for SSR in this app.
  wallets: [
    {
      groupName: "Popular",
      wallets: [injectedWallet, metaMaskWallet, coinbaseWallet, rainbowWallet, walletConnectWallet],
    },
  ],
  ssr: true,
});
