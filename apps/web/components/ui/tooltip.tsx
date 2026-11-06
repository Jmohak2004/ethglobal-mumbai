import { clsx } from "clsx";
import type { ReactNode } from "react";

/** CSS-only hover/focus tooltip. No client JS, so it works in server-rendered tables. */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "center" | "start" | "end";
  className?: string;
}) {
  return (
    <span className={clsx("group relative inline-flex", className)} tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className={clsx(
          "pointer-events-none absolute z-50 hidden w-max max-w-72 rounded border border-border bg-panel-2 px-2 py-1.5 text-[11px] leading-snug text-text group-hover:block group-focus:block",
          side === "top" ? "bottom-full mb-1" : "top-full mt-1",
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
