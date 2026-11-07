import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

/** Plain surface. Use `interactive` for cards that are links or buttons (lifts a little on hover). */
export function Card({
  className,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]",
        interactive &&
          "transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-strong hover:shadow-[var(--shadow-lift)]",
        className,
      )}
      {...props}
    />
  );
}
