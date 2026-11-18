# syntax=docker/dockerfile:1
# Gate E2E runner (M3-T12): the Playwright suite + playwright-cli. Used by the compose `e2e` service
# (profile `e2e`, never started by a plain `docker compose up`). Run: `npm --prefix e2e run test:docker`.
# Keep the image tag equal to the exact @playwright/test version in package.json.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ARG PLAYWRIGHT_CLI_VERSION=0.1.24
ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# playwright-cli (agent browser CLI) ships its own Playwright build: install the browser it expects too.
# SKIP_BROWSER_GC keeps the image's browsers for @playwright/test (the installer deletes unlinked ones).
RUN npm install -g @playwright/cli@${PLAYWRIGHT_CLI_VERSION} \
 && PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright-cli install-browser chromium \
 && npm cache clean --force

WORKDIR /e2e
RUN chown pwuser:pwuser /e2e
USER pwuser

COPY --chown=pwuser:pwuser package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY --chown=pwuser:pwuser . .

# playwright-cli inside the compose network: same host mapping as the suite (E2E_HOST_RESOLVER_RULES).
RUN mkdir -p .playwright && printf '%s\n' \
  '{ "browser": { "browserName": "chromium", "launchOptions": { "channel": "chromium",' \
  '  "args": ["--host-resolver-rules=MAP admin.localhost admin, MAP app.localhost client"] } } }' \
  > .playwright/cli.config.json

CMD ["npx", "playwright", "test"]
