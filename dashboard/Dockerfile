# Dashboard (Next.js) — production image for the VPS deploy.
# Builds standalone output; runs `node server.js` with no node_modules.
#
# NOTE: BACKEND_URL is read at BUILD time (next.config.ts rewrites are
# serialized into the standalone server), so it's an ARG pointing at
# the compose service name.

FROM node:22-alpine AS build

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

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server + static assets (standalone doesn't copy these).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000

# End-to-end probe: dashboard proxy -> rewrite -> backend /health.
# Unhealthy means the console can't reach the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/server/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
