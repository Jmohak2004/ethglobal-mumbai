import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/button";

/** Link styled like the app's Button, for navigation CTAs. */
export function CtaLink({
  href,
  variant,
  children,
}: {
  href: string;
  variant: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <ButtonLink href={href} variant={variant} size="lg">
      {children}
    </ButtonLink>
  );
}
