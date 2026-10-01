# LLM proxy server — production image for the VPS deploy (see DEPLOY.md).
# Runs as root (official node image default): simplest for a user-run
# VPS since the bind-mounted ./data needs no chown.

FROM node:22-alpine

WORKDIR /app

# Deps first for layer caching. package.json has no devDependencies;
# --omit=dev is future-proofing.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Boot-required files:
#   index.js                              — the server
#   lib/ (incl. classifier/reference-examples.json) — missing => boot crash
#   config/ (incl. models.json)           — missing => exit(1)
#   public/                               — legacy static dashboard (harmless)
COPY index.js ./
COPY lib ./lib
COPY config ./config
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8002
VOLUME /app/data

# fetch is a global in Node 18+; node:22-alpine has it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
