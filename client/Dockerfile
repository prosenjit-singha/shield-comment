# syntax=docker/dockerfile:1
# ---- build: install deps, build the TanStack Start client + server bundles into /app/dist
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# No build args: the app always calls same-origin /api (tech-stack.md §4).
RUN npm run build && npm prune --omit=dev

# ---- runtime: Node SSR server (server.mjs = srvx + Start handler + static assets) as the non-root `node` user
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=5174 \
    HOST=0.0.0.0 \
    API_UPSTREAM=http://backend:3000
WORKDIR /app
# The server bundle imports its dependencies from node_modules at runtime (production deps only).
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./
USER node
EXPOSE 5174
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5174/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
