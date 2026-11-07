import { Container } from "@/components/ui/page-header";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <Container wide className="flex flex-col gap-6 py-8 md:py-10" >
      <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="rounded-xl border border-border bg-panel">
          <SkeletonRows rows={8} />
        </div>
      </div>
    </Container>
  );
}
