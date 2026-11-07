import { clsx } from "clsx";
import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { IconInfo } from "@/components/ui/icons";

/** Label, one big number, and a quiet caption. `help` adds a plain-language explanation on hover or focus. */
export function StatCard({
  label,
  value,
  sub,
  tone,
  help,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "long" | "short" | "default";
  help?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1 rounded-xl border border-border bg-panel px-4 py-3.5 shadow-[var(--shadow-card)]", className)}>
      <div className="flex items-center gap-1.5 text-sm text-muted">
        {label}
        {help ? (
          <Tooltip content={help} label={`About ${label}`}>
            <IconInfo size={13} className="text-subtle" />
          </Tooltip>
        ) : null}
      </div>
      <div
        className={clsx(
          "num text-xl font-medium leading-7",
          tone === "long" && "text-long",
          tone === "short" && "text-short",
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}
