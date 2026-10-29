# syntax=docker/dockerfile:1.7
# Egy Dockerfile, két cél:  --target worker  |  --target web

# ── függőségek (bun workspace) ────────────────────────────────────────────
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/token-agent/package.json apps/token-agent/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/api/package.json packages/api/
COPY packages/cache/package.json packages/cache/
COPY tools/import-mysql/package.json tools/import-mysql/
RUN bun install --frozen-lockfile

FROM deps AS source
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY apps/web ./apps/web
COPY tools ./tools
COPY tsconfig.base.json ./
# A Prisma kliens generálásához nem kell élő adatbázis, csak egy URL.
RUN cd packages/db && DATABASE_URL=postgres://x:x@localhost:5432/x bunx prisma generate

# ── worker: Node futtatja a TypeScriptet közvetlenül (type stripping) ────
FROM node:24-bookworm-slim AS worker
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=source /app /app
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8090/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/src/main.ts"]

# ── web: Next.js standalone ───────────────────────────────────────────────
FROM source AS web-build
# A rewrites() a build alatt rögzül: a worker belső címe.
ARG WORKER_URL=http://worker:8090
ARG NEXT_PUBLIC_WS_URL=
ENV WORKER_URL=$WORKER_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && node ../../node_modules/next/dist/bin/next build

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
