import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/web -> monorepo root (bun workspaces, shared packages live above this app)
const repoRoot = path.resolve(here, "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@arena/shared"],
  outputFileTracingRoot: repoRoot,
  turbopack: {
    root: repoRoot,
    resolveAlias: {
      // Optional @x402/* peers of @coinbase/cdp-sdk (via wagmi's Base Account connector) are not installed.
      // Point them at an empty module; ARENA never calls those payment paths.
      "@x402/*": "./lib/shims/empty.ts",
    },
  },
};

export default nextConfig;
