# syntax=docker/dockerfile:1
# ---- build: full deps + compiled dist
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production deps + compiled output + SQL migrations.
# Also runs the compose `migrate` service (`node dist/db/migrate.js`), so no drizzle-kit in prod.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
USER node
EXPOSE 3000
# Liveness only (no DB query), so the probe doesn't keep Neon's compute awake.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/live >/dev/null || exit 1
CMD ["node", "dist/main.js"]
