import { ButtonLink } from "@/components/ui/button";
import { Container } from "@/components/ui/page-header";

export default function NotFound() {
  return (
    <Container narrow className="flex flex-col items-start gap-3 py-20">
      <div className="num text-sm text-muted">404</div>
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Page not found</h1>
      <p className="text-base text-muted">This agent or page does not exist, or it was removed.</p>
      <ButtonLink href="/leaderboard" variant="primary">
        Back to the leaderboard
      </ButtonLink>
    </Container>
  );
}
