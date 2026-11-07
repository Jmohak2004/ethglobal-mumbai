import { Container } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentLoading() {
  return (
    <Container wide className="py-8 md:py-10">
      <div aria-busy="true" aria-label="Loading agent" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-28 rounded-xl" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </Container>
  );
}
