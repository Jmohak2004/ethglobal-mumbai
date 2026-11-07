"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { MoreMenu } from "@/components/layout/more-menu";
import { RiskPill } from "@/components/layout/risk-pill";
import { WalletButton } from "@/components/layout/wallet-button";
import type { RiskDisplay } from "@/lib/types";

const LINKS = [
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/trades", label: "Trades" },
  { href: "/trade", label: "Trade" },
  { href: "/create", label: "Create agent" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-text", className)}>
      <span aria-hidden className="grid size-6 place-items-center rounded-md bg-text text-bg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 19 8-15 8 15M8 13h8" />
        </svg>
      </span>
      Arena
    </span>
  );
}

export function TopNav({ risk }: { risk: RiskDisplay }) {
  const path = usePathname();
  // Agent pages are reached from the leaderboard, so they keep the Leaderboard tab lit.
  const isActive = (href: string) =>
    href === "/leaderboard" ? path.startsWith("/leaderboard") || path.startsWith("/agents") : path.startsWith(href);

  const link = (l: (typeof LINKS)[number], mobile: boolean) => {
    const active = isActive(l.href);
    return (
      <Link
        key={l.href}
        href={l.href}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "inline-flex shrink-0 items-center rounded-lg font-medium transition-[background-color,color] duration-150 ease-out",
          mobile ? "h-8 px-3 text-sm" : "h-8 px-3 text-base",
          active ? "bg-panel-2 text-text" : "text-muted hover:bg-panel-2/70 hover:text-text",
        )}
      >
        {l.label}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-[var(--nav-h)] max-w-[1200px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="Arena home" className="shrink-0 rounded-lg">
          <Logo />
        </Link>

        <nav className="ml-4 hidden items-center gap-0.5 md:flex" aria-label="Main">
          {LINKS.map((l) => link(l, false))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RiskPill level={risk} />
          <div className="hidden sm:block">
            <WalletButton />
          </div>
          <MoreMenu />
        </div>
      </div>

      {/* Phones: the same links in a scrollable row, and the wallet button gets its own line. */}
      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-1.5 md:hidden">
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Main (mobile)">
          {LINKS.map((l) => link(l, true))}
        </nav>
        <div className="shrink-0 sm:hidden">
          <WalletButton size="sm" />
        </div>
      </div>
    </header>
  );
}
