import { clsx } from "clsx";
import type { ReactNode } from "react";

export type Tone = "long" | "short" | "warn" | "link" | "muted";

const TONES: Record<Tone, string> = {
  long: "bg-long-soft text-long",
  short: "bg-short-soft text-short",
  warn: "bg-warn-soft text-warn",
  link: "bg-accent-soft text-accent-fg",
  muted: "bg-panel-2 text-muted",
};

const DOT: Record<Tone, string> = {
  long: "bg-long",
  short: "bg-short",
  warn: "bg-warn",
  link: "bg-accent",
  muted: "bg-subtle",
};

/** Status chip with a leading dot: risk light, agent status, verdicts. Colour is never the only cue (the label says it too). */
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
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={clsx("size-1.5 rounded-full", DOT[tone])} /> : null}
      {children}
    </span>
  );
}
