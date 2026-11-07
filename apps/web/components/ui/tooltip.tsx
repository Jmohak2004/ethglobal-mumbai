"use client";

import { clsx } from "clsx";
import { useId, type ReactNode } from "react";

/**
 * CSS-only hover and focus tooltip (125ms fade, no delay once visible). The trigger is described by the tooltip for
 * assistive tech. Pass `focusable={false}` when the child is already a link or button, so there is one tab stop.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
  focusable = true,
  label,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "center" | "start" | "end";
  className?: string;
  focusable?: boolean;
  /** Accessible name for an icon-only trigger. */
  label?: string;
}) {
  const id = useId();
  return (
    <span
      className={clsx("group/tip relative inline-flex", className)}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      aria-label={focusable ? label : undefined}
      role={focusable && label ? "button" : undefined}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        className={clsx(
          "pointer-events-none invisible absolute z-50 w-max max-w-72 rounded-lg bg-text px-2.5 py-1.5 text-left text-xs font-normal leading-snug text-bg opacity-0 shadow-[var(--shadow-pop)]",
          "transition-[opacity,visibility] duration-[125ms] ease-out",
          "group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "start" && "left-0",
          align === "end" && "right-0",
        )}
      >
        {content}
      </span>
    </span>
  );
}
