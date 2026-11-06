"use client";

import { clsx } from "clsx";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** Radio-style segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={clsx("inline-flex rounded-md border border-border bg-bg p-0.5", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              "h-6 flex-1 whitespace-nowrap rounded px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40",
              active ? "bg-panel-2 text-text" : "text-muted hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
