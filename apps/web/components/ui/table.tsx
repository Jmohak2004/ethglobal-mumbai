import { clsx } from "clsx";
import type { MouseEvent, ReactNode } from "react";

/** Calm table shell. Horizontal scroll on small screens. `bare` drops the frame (for use inside a card). */
export function Table({
  children,
  className,
  bare,
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  bare?: boolean;
  /** Set false when the columns always fit, so hover tooltips are not clipped by the scroll container. */
  scroll?: boolean;
}) {
  return (
    <div className={clsx(scroll && "overflow-x-auto", !bare && "rounded-xl border border-border bg-panel shadow-[var(--shadow-card)]", className)}>
      <table className="w-full border-collapse text-base">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>;
}

export function TH({
  children,
  align = "left",
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={clsx(
        "h-10 whitespace-nowrap border-b border-border px-3 text-xs font-medium text-muted first:pl-4 last:pr-4",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TR({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLTableRowElement>) => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        "border-b border-border last:border-b-0 transition-colors duration-100 hover:bg-panel-2/70",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  align = "left",
  className,
  colSpan,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={clsx(
        "h-12 whitespace-nowrap px-3 align-middle first:pl-4 last:pr-4",
        align === "right" && "num text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-base text-muted">
        {children}
      </td>
    </tr>
  );
}
