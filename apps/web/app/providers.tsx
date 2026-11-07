"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { ToastProvider } from "@/components/ui/toast";
import { wagmiConfig } from "@/lib/wagmi";

// RainbowKit light theme re-skinned to the ARENA palette.
const base = lightTheme({
  accentColor: "#17181b",
  accentColorForeground: "#ffffff",
  borderRadius: "medium",
  fontStack: "system",
  overlayBlur: "small",
});

const arenaTheme = {
  ...base,
  colors: {
    ...base.colors,
    modalBackdrop: "rgba(23, 24, 27, 0.3)",
    modalBackground: "#ffffff",
    modalBorder: "#e7e7ea",
    modalText: "#17181b",
    modalTextDim: "#62666f",
    modalTextSecondary: "#62666f",
    generalBorder: "#e7e7ea",
    generalBorderDim: "#f4f4f6",
    menuItemBackground: "#f4f4f6",
    connectButtonBackground: "#ffffff",
    connectButtonInnerBackground: "#f4f4f6",
    connectButtonText: "#17181b",
    closeButtonBackground: "#f4f4f6",
    actionButtonSecondaryBackground: "#f4f4f6",
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
