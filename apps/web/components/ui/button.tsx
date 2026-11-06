import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "long" | "short";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-text text-bg border-text hover:bg-text/90",
  secondary: "bg-panel-2 text-text border-border hover:bg-border",
  ghost: "bg-transparent text-muted border-transparent hover:text-text hover:bg-panel-2",
  long: "bg-long text-bg border-long hover:brightness-110",
  short: "bg-short text-bg border-short hover:brightness-110",
};

const SIZES: Record<Size, string> = {
  sm: "h-6 px-2 text-[11px]",
  md: "h-7 px-3 text-[12px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
