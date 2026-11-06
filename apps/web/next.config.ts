import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/web -> monorepo root (bun workspaces, shared packages live above this app)
const repoRoot = path.resolve(here, "../..");

// Load the monorepo root .env (server secrets and NEXT_PUBLIC_* values) before Next reads the config.
// bun does not hoist @next/env to the app, so resolve it from next's own install.
const nextDir = path.dirname(createRequire(import.meta.url).resolve("next/package.json"));
const { loadEnvConfig } = createRequire(path.join(nextDir, "package.json"))("@next/env") as {
  loadEnvConfig: (dir: string, dev?: boolean, log?: Console, forceReload?: boolean) => unknown;
};
// forceReload: Next has already loaded (and cached) apps/web's env by the time this config runs.
loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production", console, true);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@arena/shared", "@arena/db", "@arena/flash", "@arena/policy", "@arena/zerog"],
  // Native / wasm / SDK packages stay in node_modules (Postgres driver, PGlite wasm, 0G storage SDK).
  // @arena/db is listed in transpilePackages but never bundled: lib/server/db.ts imports it at runtime.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "postgres",
    "@0gfoundation/0g-storage-ts-sdk",
    "ethers",
  ],
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
