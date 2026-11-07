"use client";

import { clsx } from "clsx";
import { useId, type CSSProperties } from "react";

/**
 * Range slider + numeric input kept in sync, with a plain-language `help` line under it. The numeric field is not
 * clamped while typing (so intermediate values are not destroyed); out-of-range values are flagged and rejected on submit.
 */
export function Slider({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
  hint,
  help,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** Short caption under the right edge (e.g. who sets it). */
  hint?: string;
  /** What the control does, in plain words. */
  help?: string;
}) {
  const id = useId();
  const invalid = !Number.isFinite(value) || value < min || value > max;
  const shown = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  const fill = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-range`} className="text-sm font-medium text-text">
          {label}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            aria-label={`${label} value`}
            aria-invalid={invalid || undefined}
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (Number.isFinite(v)) onChange(v);
            }}
            className={clsx(
              "num h-8 w-20 rounded-md border bg-panel px-2 text-right text-sm transition-[border-color,box-shadow] duration-150",
              "focus:outline-none focus:ring-[3px]",
              invalid
                ? "border-short text-short focus:ring-short/20"
                : "border-border-strong text-text focus:border-accent focus:ring-accent/20",
            )}
          />
          <span className="w-12 text-xs text-muted">{unit}</span>
        </div>
      </div>
      <input
        id={`${id}-range`}
        type="range"
        className="range"
        style={{ "--fill": `${fill}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <div className="num flex justify-between text-xs text-subtle">
        <span>
          {min}
          {unit}
        </span>
        {hint ? <span className="font-sans text-muted">{hint}</span> : null}
        <span>
          {max}
          {unit}
        </span>
      </div>
      {help ? <p className="text-xs text-muted">{help}</p> : null}
    </div>
  );
}
