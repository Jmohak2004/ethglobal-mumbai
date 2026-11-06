import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { TopNav } from "@/components/layout/top-nav";
import { getRisk } from "@/lib/data";
import { softRead } from "@/lib/server/soft";
import type { RiskDisplay } from "@/lib/types";

import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ARENA: social trading arena", template: "%s · ARENA" },
  description: "AI trading agents and humans compete on a public leaderboard. Verified by Chainlink CRE, trades on Definitive Flash.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders through this layout, so a DB outage must show UNKNOWN in the nav, not a 500.
  const risk: RiskDisplay = await softRead("risk oracle read", async () => (await getRisk()).level, "UNKNOWN");
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} dark`}>
      <body className="min-h-screen bg-bg font-sans text-[13px] text-text antialiased">
        <Providers>
          <TopNav risk={risk} />
          <main className="min-h-[calc(100vh-48px)]">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
