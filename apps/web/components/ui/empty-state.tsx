import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Friendly empty or "nothing here yet" block: icon, one line of what it is, one line of what to do, an optional action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={clsx("flex flex-col items-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14", className)}>
      {icon ? (
        <div className="grid size-10 place-items-center rounded-xl bg-panel-2 text-muted ring-1 ring-inset ring-border">{icon}</div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <h3 className="text-base font-semibold text-text">{title}</h3>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
