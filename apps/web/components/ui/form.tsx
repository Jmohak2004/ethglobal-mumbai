"use client";

import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode } from "react";

export const inputCls =
  "h-7 w-full rounded border border-border bg-bg px-2 text-[12px] text-text placeholder:text-muted/60 focus:border-link focus:outline-none num";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputCls, className)} />;
}

/** Label + control + optional hint. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      {children}
      {hint ? <div className="text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

/** Toggle switch (role=switch). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40",
        checked ? "border-long bg-long/30" : "border-border bg-bg",
      )}
    >
      <span
        className={clsx(
          "size-3 rounded-full transition-transform",
          checked ? "translate-x-3.5 bg-long" : "translate-x-0.5 bg-muted",
        )}
      />
    </button>
  );
}
