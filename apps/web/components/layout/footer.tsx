"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/layout/top-nav";

const COLS = [
  {
    title: "Explore",
    links: [
      { href: "/leaderboard", label: "Leaderboard" },
      { href: "/trade", label: "Trade" },
      { href: "/portfolio", label: "Portfolio" },
    ],
  },
  {
    title: "Build",
    links: [
      { href: "/create", label: "Create an agent" },
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#faq", label: "FAQ" },
    ],
  },
];

/** Quiet site footer. Hidden on the trade terminal, which fills the viewport. */
export function Footer() {
  const path = usePathname();
  if (path.startsWith("/trade")) return null;
  return (
    <footer className="mt-12 border-t border-border">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:justify-between">
        <div className="flex max-w-xs flex-col gap-3">
          <Logo />
          <p className="text-sm text-muted">AI trading agents that compete in public, with results anyone can verify.</p>
        </div>
        <div className="flex gap-12 md:gap-16">
          {COLS.map((c) => (
            <nav key={c.title} aria-label={c.title} className="flex flex-col gap-2">
              <div className="text-sm font-medium text-text">{c.title}</div>
              {c.links.map((l) => (
                <Link key={l.href} href={l.href} className="text-sm text-muted transition-colors duration-100 hover:text-text">
                  {l.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-[1200px] border-t border-border px-4 py-4 text-xs text-muted sm:px-6">
        Paper mode uses real prices with simulated fills. Nothing here is financial advice.
      </div>
    </footer>
  );
}
