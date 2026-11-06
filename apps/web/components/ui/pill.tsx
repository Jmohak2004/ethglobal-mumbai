import { clsx } from "clsx";
import type { ReactNode } from "react";

export type Tone = "long" | "short" | "warn" | "link" | "muted";

const TONES: Record<Tone, string> = {
  long: "border-long/40 bg-long/10 text-long",
  short: "border-short/40 bg-short/10 text-short",
  warn: "border-warn/40 bg-warn/10 text-warn",
  link: "border-link/40 bg-link/10 text-link",
  muted: "border-border bg-panel-2 text-muted",
};

const DOT: Record<Tone, string> = {
  long: "bg-long",
  short: "bg-short",
  warn: "bg-warn",
  link: "bg-link",
  muted: "bg-muted",
};

/** Rounded status chip with a leading dot. Used for risk level, agent status and verdicts. */
export function Pill({
  tone = "muted",
  dot = true,
  children,
  className,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "num inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className={clsx("size-1.5 rounded-full", DOT[tone])} /> : null}
      {children}
    </span>
  );
}
