"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { ToastProvider } from "@/components/ui/toast";
import { wagmiConfig } from "@/lib/wagmi";

// RainbowKit dark theme re-skinned to the ARENA palette.
const base = darkTheme({
  accentColor: "#50d2c1",
  accentColorForeground: "#0b1417",
  borderRadius: "small",
  fontStack: "system",
  overlayBlur: "none",
});

const arenaTheme = {
  ...base,
  colors: {
    ...base.colors,
    modalBackdrop: "rgba(0, 0, 0, 0.6)",
    modalBackground: "#0f1a1e",
    modalBorder: "#1c2d34",
    modalText: "#e6f0ee",
    modalTextDim: "#8a9a98",
    modalTextSecondary: "#8a9a98",
    generalBorder: "#1c2d34",
    generalBorderDim: "#13222a",
    menuItemBackground: "#13222a",
    connectButtonBackground: "#0f1a1e",
    connectButtonInnerBackground: "#13222a",
    connectButtonText: "#e6f0ee",
    closeButtonBackground: "#13222a",
    actionButtonSecondaryBackground: "#13222a",
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={arenaTheme} modalSize="compact">
          <ToastProvider>{children}</ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
