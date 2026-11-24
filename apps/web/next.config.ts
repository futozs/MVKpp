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

/**
 * Fejlesztéskor (vagy ha a TILES_URL meg van adva) a térképcsempéket egy helyi
 * `pmtiles serve` adja; élesben a Caddy irányítja őket a tiles konténerre, a Next nem is látja.
 */
const TILES_URL = (process.env.TILES_URL ?? (process.env.NODE_ENV !== "production" ? "http://127.0.0.1:8081" : "")).replace(/\/+$/, "");

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
    const worker = WORKER_PATHS.map((source) => ({
      source,
      destination: `${WORKER_URL}${source}`,
    }));
    return TILES_URL ? [...worker, { source: "/tiles/:path*", destination: `${TILES_URL}/:path*` }] : worker;
  },
  // Az iOS-app passkey-je (webcredentials) ezt a fájlt olvassa: kiterjesztés nélküli, ezért a típust
  // meg kell adni  az Apple csak application/json-t fogad el, átirányítás nélkül.
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      // A térkép fontjai és ikonjai verziózott könyvtárban vannak (public/map-assets/vN): örökre
      // gyorsítótárazhatók. A .pbf típusa nélkül a Caddy nem tömörítené (octet-stream).
      {
        source: "/map-assets/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/map-assets/:path*.pbf",
        headers: [{ key: "Content-Type", value: "application/x-protobuf" }],
      },
    ];
  },
};

export default nextConfig;
