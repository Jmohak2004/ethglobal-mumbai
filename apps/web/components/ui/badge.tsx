import { clsx } from "clsx";
import type { ReactNode } from "react";

export type BadgeTone = "accent" | "warn" | "neutral" | "link";

const TONES: Record<BadgeTone, string> = {
  accent: "border-long/40 text-long",
  warn: "border-warn/50 text-warn",
  neutral: "border-border text-muted",
  link: "border-link/40 text-link",
};

/** Small rectangular label, e.g. PAPER, CRE, Self-funded, template name. */
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
        "inline-flex h-4 items-center whitespace-nowrap rounded border px-1 text-[10px] font-medium uppercase tracking-wide",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
