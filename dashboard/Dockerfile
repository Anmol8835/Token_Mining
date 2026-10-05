# Dashboard (Next.js) — production image for the VPS deploy.
# Builds standalone output; runs `node server.js` with no node_modules.
#
# node:22-slim (glibc), not alpine: better-sqlite3 ships prebuilt
# glibc binaries but no musl ones — alpine would need a node-gyp
# compile (python3/make/g++ in the build stage) that can OOM the
# laptop-built flow on small machines.
#
# NOTE: BACKEND_URL is read at BUILD time (next.config.ts rewrites are
# serialized into the standalone server), so it's an ARG pointing at
# the compose service name.

FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable

# Deps first for layer caching. package.json carries
# packageManager: pnpm@10.11.0, which corepack's shim honors.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
ARG BACKEND_URL=http://llm-proxy:8002
ENV BACKEND_URL=${BACKEND_URL}
RUN pnpm build

FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server + static assets (standalone doesn't copy these).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# better-sqlite3 v13 ships its native binding inside the package as
# prebuilds/<platform>.node (loaded at runtime). Next's output tracing
# may miss the binary, so copy the prebuilds dir wholesale. bcryptjs
# is pure JS and traces fine.
COPY --from=build /app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/prebuilds ./node_modules/better-sqlite3/prebuilds

# lib/schema.sql (the shared-DB schema mirror, applied at boot by
# lib/db.ts) and lib/plans.json (the plan catalog mirror) are
# non-code assets — tracing doesn't pick them up either.
COPY --from=build /app/lib/schema.sql ./lib/schema.sql
COPY --from=build /app/lib/plans.json ./lib/plans.json

EXPOSE 3000

# End-to-end probe: dashboard proxy -> rewrite -> backend /health.
# Unhealthy means the console can't reach the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/server/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
