"use client";

import { clsx } from "clsx";
import { useRef, type KeyboardEvent } from "react";

export interface TabItem<T extends string> {
  value: T;
  label: string;
}

/** State-driven tabs (leaderboard kind, order-ticket type, bottom panel). Arrow keys move between tabs. */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  className,
  label,
}: {
  value: T;
  items: TabItem<T>[];
  onChange: (v: T) => void;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = items.findIndex((x) => x.value === value);
    const next = items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
    if (next) {
      onChange(next.value);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
    }
  };
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className={clsx("flex items-center gap-1 border-b border-border", className)}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={clsx(
              "-mb-px h-9 border-b-2 px-3 text-base font-medium transition-[color,border-color] duration-150 ease-out",
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
