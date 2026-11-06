import { clsx } from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded bg-panel-2", className)} />;
}

export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-1.5 p-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}
