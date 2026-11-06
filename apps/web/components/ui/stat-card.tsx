import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Label + big number. tone colours the value (long / short / muted). */
export function StatCard({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "long" | "short" | "default";
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1 rounded-md border border-border bg-panel px-3 py-2", className)}>
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div
        className={clsx(
          "num text-[16px] font-semibold leading-tight",
          tone === "long" && "text-long",
          tone === "short" && "text-short",
        )}
      >
        {value}
      </div>
      {sub ? <div className="num text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}
