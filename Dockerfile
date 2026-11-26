# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app

# Required for git-hosted dependencies in package-lock.json during `npm ci`
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

# Build Telegram Web Z FIRST (its Vite build empties `dist/`), then build HeroUI Console into `dist/console/`.
# In Dokploy, set TELEGRAM_API_ID, TELEGRAM_API_HASH, and BASE_URL in Environment Variables before deploying.
ARG TELEGRAM_API_ID=""
ARG TELEGRAM_API_HASH=""
ARG BASE_URL=https://localhost/
ARG APP_TITLE="Telegram Web Z Manager (Unofficial)"
ENV APP_ENV=production \
    NODE_ENV=production \
    TELEGRAM_API_ID=${TELEGRAM_API_ID} \
    TELEGRAM_API_HASH=${TELEGRAM_API_HASH} \
    BASE_URL=${BASE_URL} \
    APP_TITLE=${APP_TITLE}

RUN npm run build:production && npm run build:console

# Keep only production dependencies + pinned tsx runtime for the Node server stage
RUN npm prune --omit=dev && npm install --no-save --no-audit --no-fund tsx@4.23.15

FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    TRUST_PROXY=true \
    REQUIRE_HTTPS=true

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/src ./src
COPY --from=builder /app/LICENSE ./LICENSE

RUN mkdir -p /app/data && chown -R node:node /app/data && chmod 700 /app/data

USER node
EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./node_modules/tsx/dist/cli.mjs", "server/index.ts"]
