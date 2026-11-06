import { Suspense } from "react";

import { PortfolioView } from "@/components/portfolio/portfolio-view";

export const metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="px-4 py-3">
      <Suspense fallback={null}>
        <PortfolioView />
      </Suspense>
    </div>
  );
}
