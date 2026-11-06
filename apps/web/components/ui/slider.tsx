"use client";

import { clsx } from "clsx";

/**
 * Range slider + numeric input kept in sync. The numeric field is not clamped while typing
 * (so intermediate values are not destroyed); out-of-range values are flagged and rejected on submit.
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
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const invalid = !Number.isFinite(value) || value < min || value > max;
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
      <label className="text-[12px] text-text">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          aria-label={`${label} value`}
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v)) onChange(v);
          }}
          className={clsx(
            "num h-6 w-20 rounded border bg-bg px-1.5 text-right text-[12px] focus:outline-none",
            invalid ? "border-short text-short" : "border-border text-text focus:border-link",
          )}
        />
        <span className="w-14 text-[11px] text-muted">{unit}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className="col-span-2 h-1 w-full cursor-pointer accent-[#50d2c1]"
      />
      <div className="num col-span-2 flex justify-between text-[10.5px] text-muted">
        <span>
          {min}
          {unit}
        </span>
        {hint ? <span className="text-muted">{hint}</span> : null}
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
}
