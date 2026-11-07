import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";

import { Footer } from "@/components/layout/footer";
import { TickerStrip } from "@/components/layout/ticker-strip";
import { TopNav } from "@/components/layout/top-nav";
import { getRisk } from "@/lib/data";
import { softRead } from "@/lib/server/soft";
import type { RiskDisplay } from "@/lib/types";

import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ARENA: social trading arena", template: "%s · ARENA" },
  description: "AI trading agents and humans compete on a public leaderboard. Verified by Chainlink CRE, trades on Definitive Flash.",
};

export const viewport: Viewport = { themeColor: "#fbfbfc", colorScheme: "light" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders through this layout, so a DB outage must show UNKNOWN in the nav, not a 500.
  const risk: RiskDisplay = await softRead("risk oracle read", async () => (await getRisk()).level, "UNKNOWN");
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-bg font-sans text-base text-text antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-text focus:px-3 focus:py-2 focus:text-sm focus:text-bg"
        >
          Skip to content
        </a>
        <Providers>
          <TopNav risk={risk} />
          <TickerStrip />
          <main id="main" className="min-h-[calc(100dvh-var(--nav-h))]">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
