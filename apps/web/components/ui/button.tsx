import { clsx } from "clsx";
import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "accent" | "long" | "short" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  // Inverted CTA, as in dailytodo: near-black fill, white text.
  primary: "border-text bg-text text-bg hover:bg-text-2 hover:border-text-2",
  secondary: "border-border-strong bg-panel text-text shadow-[var(--shadow-card)] hover:bg-panel-2",
  ghost: "border-transparent bg-transparent text-muted hover:bg-panel-2 hover:text-text",
  accent: "border-accent bg-accent text-white hover:border-accent-hover hover:bg-accent-hover",
  long: "border-long bg-long text-white hover:brightness-110",
  short: "border-short bg-short text-white hover:brightness-110",
  danger: "border-short/30 bg-short-soft text-short hover:bg-short/15",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-9 gap-2 px-3.5 text-base",
  lg: "h-11 gap-2 px-5 text-base",
};

/** Class string shared by <Button> and link-styled buttons so both look identical. */
export function buttonClass({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return clsx(
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg border font-medium",
    "transition-[background-color,border-color,color,transform,filter] duration-150 ease-out",
    "enabled:active:scale-[0.97] aria-disabled:pointer-events-none",
    "disabled:opacity-45 aria-disabled:opacity-45",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}

/** Navigation styled as a button (internal links only). */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link href={href} className={buttonClass({ variant, size, className })} {...props} />;
}
