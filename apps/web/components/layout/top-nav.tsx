"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { RiskPill } from "@/components/layout/risk-pill";
import { WalletButton } from "@/components/layout/wallet-button";
import type { RiskLevel } from "@arena/shared";

const LINKS = [
  { href: "/", label: "Leaderboard" },
  { href: "/trade", label: "Trade" },
  { href: "/create", label: "Create Agent" },
  { href: "/portfolio", label: "Portfolio" },
];

export function TopNav({ risk }: { risk: RiskLevel }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 flex h-12 items-center gap-6 border-b border-border bg-bg px-4">
      <Link href="/" className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.2em] text-text">
        <span className="grid size-5 place-items-center rounded bg-long text-[11px] font-bold text-bg">A</span>
        ARENA
      </Link>

      <nav className="flex items-center gap-1" aria-label="Main">
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" || path.startsWith("/agents") : path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "h-8 rounded-md px-3 text-[12.5px] leading-8 transition-colors",
                active ? "bg-panel-2 text-text" : "text-muted hover:text-text",
              )}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <RiskPill level={risk} />
        <span className="num flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-muted">
          <span className="size-1.5 rounded-full bg-link" />
          Base
        </span>
        <WalletButton />
      </div>
    </header>
  );
}
