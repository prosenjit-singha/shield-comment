#!/usr/bin/env bash
# Lighthouse (mobile preset) for the C1 landing `/` + `/bn` (M8-T13, client.md §2 gate: Performance ≥ 80, SEO ≥ 90).
# Runs the Lighthouse CLI through npx (not a dependency) on Playwright's Chromium (Chrome isn't installed in WSL).
# Usage: client/scripts/lighthouse.sh [base-url]   (default: the Docker client, http://localhost:5174)
# Reports go to a temp dir, never into git. Exit 1 when a page misses the gate.
set -euo pipefail

BASE="${1:-http://localhost:5174}"
CHROME="${CHROME_PATH:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)}"
[ -x "$CHROME" ] || { echo "No Chromium found; set CHROME_PATH or run: npx playwright install chromium" >&2; exit 2; }
OUT="$(mktemp -d)"
FAIL=0

for path in / /bn; do
  curl -fsS -o /dev/null "$BASE$path" # warm-up: the first SSR after a container start is slow (seen: Performance 45 → 100)
  report="$OUT/$( [ "$path" = / ] && echo en || echo bn ).json"
  npx -y lighthouse "$BASE$path" --chrome-path="$CHROME" --chrome-flags="--headless=new --no-sandbox" \
    --only-categories=performance,accessibility,best-practices,seo --output=json --output-path="$report" --quiet
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const s = Object.fromEntries(Object.values(r.categories).map((c) => [c.id, Math.round(c.score * 100)]))
    const m = ["largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift"].map((id) => `${id} ${r.audits[id].displayValue}`)
    console.log(`${process.argv[2]}  performance ${s.performance} · accessibility ${s.accessibility} · best-practices ${s["best-practices"]} · seo ${s.seo}  (${m.join(", ")})`)
    process.exit(s.performance >= 80 && s.seo >= 90 ? 0 : 1)
  ' "$report" "$path" || FAIL=1
done

echo "reports: $OUT"
exit "$FAIL"
