# LLM proxy server — production image for the VPS deploy (see DEPLOY.md).
# Runs as root (official node image default): simplest for a user-run
# VPS since the bind-mounted ./data needs no chown.
#
# node:22-slim (glibc), not alpine: better-sqlite3 ships prebuilt
# glibc binaries but no musl ones — on alpine npm falls back to a
# node-gyp compile (python3/make/g++ + OOM risk on the 1 GB VM).

FROM node:22-slim

WORKDIR /app

# Deps first for layer caching. package.json has no devDependencies;
# --omit=dev is future-proofing. --ignore-scripts: npm otherwise
# insists on a node-gyp rebuild for better-sqlite3 (no python/make/g++
# here) even though the package ships prebuilt binaries for every
# platform in prebuilds/ — nothing in this tree needs install scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Boot-required files:
#   index.js                              — the server
#   lib/ (incl. classifier/reference-examples.json) — missing => boot crash
#   config/ (incl. models.json)           — missing => exit(1)
#   db/                                   — schema.sql (lib/db.js applies it
#                                           at boot) + create-user.js (run via
#                                           `docker compose exec`)
#   public/                               — legacy static dashboard (harmless)
COPY index.js ./
COPY lib ./lib
COPY config ./config
COPY db ./db
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8002
VOLUME /app/data

# fetch is a global in Node 18+; node:22-alpine has it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
