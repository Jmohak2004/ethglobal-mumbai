import { clsx } from "clsx";
import type { MouseEvent, ReactNode } from "react";

/** Dense table shell. Horizontal scroll on small screens; no shadows. `bare` drops the frame (for use inside a Panel). */
export function Table({ children, className, bare }: { children: ReactNode; className?: string; bare?: boolean }) {
  return (
    <div className={clsx("overflow-x-auto", !bare && "rounded-md border border-border bg-panel", className)}>
      <table className="num w-full border-collapse text-[12px]">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 bg-panel">{children}</thead>;
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
        "h-8 whitespace-nowrap border-b border-border px-2 text-[10.5px] font-medium uppercase tracking-wider text-muted",
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
        "h-8 border-b border-border/60 last:border-b-0 hover:bg-panel-2",
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
        "whitespace-nowrap px-2 py-1 align-middle",
        align === "right" && "text-right",
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
      <td colSpan={colSpan} className="px-3 py-6 text-center text-[12px] text-muted">
        {children}
      </td>
    </tr>
  );
}
