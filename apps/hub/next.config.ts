import path from "node:path";
import type { NextConfig } from "next";

/** A bun workspace gyökere: innen jön a hoistolt node_modules. */
const MONOREPO_ROOT = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // A workspace-csomagok TypeScript-forrásként érkeznek (.ts importokkal).
  transpilePackages: ["@mvk/core", "@mvk/db"],
  serverExternalPackages: ["pg"],
  agentRules: false,
  outputFileTracingRoot: MONOREPO_ROOT,
  turbopack: { root: MONOREPO_ROOT },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
