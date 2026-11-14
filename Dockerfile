# MailMe — one image for api, worker, migrate and the CLI (TypeScript run directly with tsx).
#   docker compose build
#   docker compose exec worker node_modules/.bin/tsx src/cli/main.ts <command>   (the worker holds the private key)

ARG NODE_IMAGE=node:22-alpine

# ── Dependencies (dev dependencies included: tsx runs the app, vite builds the SPA) ─────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g pnpm@9.15.9
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── SPA build → web/dist ─────────────────────────────────────────────────────────────────────────────────
FROM deps AS web
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN pnpm build:web

# ── Runtime ──────────────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# tini: signal forwarding (graceful SIGTERM for the worker); postgresql16-client: pg_dump for `backup:dump`.
RUN apk add --no-cache tini postgresql16-client && npm install -g pnpm@9.15.9
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
# The setup script (account step of scripts/docker-setup.sh, --new-link for a lost password).
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/server/main.ts"]
