import { Suspense } from "react";

import { PortfolioView } from "@/components/portfolio/portfolio-view";

export const metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <Suspense fallback={null}>
      <PortfolioView />
    </Suspense>
  );
}
