import path from "node:path";
import type { NextConfig } from "next";

/**
 * A realtime worker címe. Ide mennek a lenti útvonalak, ha nincs a Next előtt
 * reverse proxy (fejlesztéskor, vagy egyszerű éles telepítésnél).
 *
 * Figyelem: a rewrites() a `next build` alatt fut le, és az eredmény a
 * .next/routes-manifest.json-ba kerül  a WORKER_URL-t tehát a BUILD idején
 * kell megadni, futásidőben már nem írja felül.
 */
const WORKER_URL = (process.env.WORKER_URL ?? "http://127.0.0.1:8090").replace(
  /\/+$/,
  "",
);

/**
 * A workerre továbbított útvonalak. A /stats, /push, /account és /v3 szándékosan
 * hiányzik: azok Next route handlerek. Mivel az /api/* is a workeré, az app/api/
 * alá nem kerülhet route handler.
 */
const WORKER_PATHS = [
  "/live/:path*",
  "/gtfs/:path*",
  "/weather",
  "/engine/:path*",
  "/_health",
  "/_jwt",
  "/_export",
  "/_ingest",
  "/_renew",
  "/system/:path*",
  "/agent/:path*",
  "/api/:path*",
  "/MVK_mobilapp/:path*",
];

/** A bun workspace gyökere: innen jön a hoistolt node_modules. */
const MONOREPO_ROOT = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // A workspace-csomagok TypeScript-forrásként érkeznek (.ts importokkal).
  transpilePackages: ["@mvk/api", "@mvk/cache", "@mvk/core", "@mvk/db"],
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "@simplewebauthn/server", "ioredis"],
  // A next dev ne írjon AGENTS.md-t a repóba.
  agentRules: false,
  outputFileTracingRoot: MONOREPO_ROOT,
  turbopack: {
    root: MONOREPO_ROOT,
  },
  async rewrites() {
    return WORKER_PATHS.map((source) => ({
      source,
      destination: `${WORKER_URL}${source}`,
    }));
  },
};

export default nextConfig;
