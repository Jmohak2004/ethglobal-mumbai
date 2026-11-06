import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-16">
      <div className="num text-[12px] text-muted">404</div>
      <h1 className="text-[18px] font-semibold">Page not found</h1>
      <p className="text-[12.5px] text-muted">This agent or page does not exist, or it was removed.</p>
      <Link href="/leaderboard" className="text-[12.5px] text-link hover:underline">
        Back to the leaderboard
      </Link>
    </div>
  );
}
