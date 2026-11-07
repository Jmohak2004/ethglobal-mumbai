import { clsx } from "clsx";
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warn" | "danger" | "link";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-panel-2 text-muted ring-border",
  accent: "bg-accent-soft text-accent-fg ring-accent/20",
  link: "bg-accent-soft text-accent-fg ring-accent/20",
  success: "bg-long-soft text-long ring-long/20",
  warn: "bg-warn-soft text-warn ring-warn/25",
  danger: "bg-short-soft text-short ring-short/20",
};

/** Small rounded label: template name, Paper, Verified, Owner only. Sentence case, never shouting. */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-medium ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
