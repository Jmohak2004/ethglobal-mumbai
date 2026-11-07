"use client";

import { clsx } from "clsx";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export const inputCls =
  "h-9 w-full rounded-lg border border-border-strong bg-panel px-3 text-base text-text shadow-[var(--shadow-card)] " +
  "placeholder:text-subtle transition-[border-color,box-shadow] duration-150 ease-out " +
  "hover:border-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/20 " +
  "disabled:cursor-not-allowed disabled:bg-panel-2 disabled:opacity-60 aria-[invalid=true]:border-short aria-[invalid=true]:focus:ring-short/20 num";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputCls, className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(inputCls, "h-auto min-h-20 py-2", className)} />;
}

/** Label + control + optional hint. The label wraps the control, so clicking it focuses the input. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{label}</span>
        {children}
      </label>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color] duration-150 ease-out disabled:opacity-45",
        checked ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span
        className={clsx(
          "size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150 ease-out",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
