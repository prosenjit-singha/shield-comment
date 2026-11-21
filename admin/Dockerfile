# syntax=docker/dockerfile:1
# ---- build: install deps and produce the static bundle in /app/dist
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# No VITE_* build args: the app always calls same-origin /api (nginx proxies it below).
RUN npm run build

# ---- runtime: static files + /api proxy, served by non-root nginx on 5173
FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
# Backend base URL (no path; /api/... is passed through as-is) and the DNS resolver nginx uses for it.
# Defaults fit docker compose (service `backend`, Docker's embedded DNS, IPv4). Fly.io (fly.toml):
# NGINX_RESOLVER=[fdaa::3] + NGINX_RESOLVER_IPV6=on (.internal names are IPv6 only), FORWARDED_FOR_MODE=pass.
ENV API_UPSTREAM=http://backend:3000 \
    NGINX_RESOLVER=127.0.0.11 \
    NGINX_RESOLVER_IPV6=off \
    FORWARDED_FOR_MODE=append
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 5173
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5173/healthz >/dev/null || exit 1
