"use client";

import { clsx } from "clsx";

export interface TabItem<T extends string> {
  value: T;
  label: string;
}

/** State-driven tabs (leaderboard kind, order-ticket type, bottom panel). */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  className,
}: {
  value: T;
  items: TabItem<T>[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={clsx("flex items-center gap-1 border-b border-border", className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={clsx(
              "h-8 border-b-2 px-2.5 text-[12px] font-medium transition-colors",
              active ? "border-text text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
