import { clsx } from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";

/** Link styled like the app's Button, for navigation CTAs. */
export function CtaLink({
  href,
  variant,
  children,
}: {
  href: string;
  variant: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border px-4 text-[13px] font-medium transition-colors",
        variant === "primary" ? "border-long bg-long text-bg hover:brightness-110" : "border-border bg-panel-2 text-text hover:bg-border",
      )}
    >
      {children}
    </Link>
  );
}
