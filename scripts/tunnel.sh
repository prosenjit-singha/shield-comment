#!/usr/bin/env bash
# Local tunnel for Meta webhooks (M4-T13; TASKS.md Module 4 D5 + D1).
#
# Exposes the local backend (default localhost:3000) on the static zrok2 name
# `shield-comment-dev` in the `public` namespace -> https://shield-comment-dev.shares.zrok.io
# and prints the URLs to paste into the Meta test app. Creates the name on first use.
# Guide: docs/project-documentation/meta-webhooks-local.md
#
# Usage:
#   scripts/tunnel.sh                 # check, create the name if missing, run the share (Ctrl-C stops it)
#   scripts/tunnel.sh --check         # only check prerequisites and print the URLs (creates nothing)
#   scripts/tunnel.sh -- --headless   # anything after `--` goes to `zrok2 share public`
#
# Env overrides:
#   TUNNEL_NAME=shield-comment-dev    zrok2 name (lower-case letters, digits, dashes)
#   TUNNEL_NAMESPACE=public           zrok2 namespace token
#   TUNNEL_PORT=3000                  local backend port
#   TUNNEL_HOST=localhost             local backend host
#   CLIENT_PUBLIC_URL=http://app.localhost:5174   client origin (only for the OAuth redirect hint)
#
# Never prints zrok tokens or app secrets.
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-shield-comment-dev}"
TUNNEL_NAMESPACE="${TUNNEL_NAMESPACE:-public}"
TUNNEL_PORT="${TUNNEL_PORT:-3000}"
TUNNEL_HOST="${TUNNEL_HOST:-localhost}"
CLIENT_URL="${CLIENT_PUBLIC_URL:-http://app.localhost:5174}"
CLIENT_URL="${CLIENT_URL%/}"

mode="run"
share_args=()

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'tunnel: error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'tunnel: warning: %s\n' "$*" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) mode="check" ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      share_args+=("$@")
      break
      ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done

[[ "$TUNNEL_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  die "TUNNEL_NAME '$TUNNEL_NAME' is not a valid name (lower-case letters, digits, dashes)"
[[ "$TUNNEL_NAMESPACE" =~ ^[A-Za-z0-9_-]+$ ]] || die "TUNNEL_NAMESPACE '$TUNNEL_NAMESPACE' is not valid"
[[ "$TUNNEL_PORT" =~ ^[0-9]{1,5}$ ]] && ((TUNNEL_PORT >= 1 && TUNNEL_PORT <= 65535)) ||
  die "TUNNEL_PORT '$TUNNEL_PORT' is not a port number"

command -v zrok2 >/dev/null 2>&1 ||
  die "zrok2 is not installed. Install zrok v2 (https://docs.zrok.io) and run 'zrok2 enable <account token>'."
command -v node >/dev/null 2>&1 || die "node is required (used to read zrok2 JSON output)"

# Is this machine's zrok2 environment enabled? `zrok2 status` masks secrets as <<SET>> unless --secrets.
status_out="$(zrok2 status 2>&1)" || die "'zrok2 status' failed; is zrok2 configured?"
grep -Eq 'EnvZId.*<<SET>>' <<<"$status_out" ||
  die "the zrok2 environment is not enabled. Run 'zrok2 enable <account token>' (token from the zrok web console; never commit it)."
unset status_out

# json_field <json> <match-key> <match-value> <field>: prints <field> of the first array item whose
# <match-key> equals <match-value> (empty when none; `null`/empty output counts as an empty list).
json_field() {
  node -e '
    const [raw, key, value, field] = process.argv.slice(1);
    let list = [];
    try { list = JSON.parse(raw || "[]") ?? []; } catch { process.exit(3); }
    const hit = Array.isArray(list) ? list.find((item) => item && item[key] === value) : undefined;
    if (hit && hit[field] != null) process.stdout.write(String(hit[field]));
  ' "$1" "$2" "$3" "$4"
}

namespaces_json="$(zrok2 list namespaces --json 2>/dev/null)" || die "'zrok2 list namespaces' failed (network or account problem)"
ns_host="$(json_field "$namespaces_json" namespaceToken "$TUNNEL_NAMESPACE" name)" ||
  die "could not read 'zrok2 list namespaces --json' output"
[[ -n "$ns_host" ]] || die "namespace '$TUNNEL_NAMESPACE' is not available to this zrok2 account"

name_exists() {
  local names_json found
  names_json="$(zrok2 list names -n "$TUNNEL_NAMESPACE" --json 2>/dev/null)" || die "'zrok2 list names' failed"
  found="$(json_field "$names_json" name "$TUNNEL_NAME" name)" || die "could not read 'zrok2 list names --json' output"
  [[ "$found" == "$TUNNEL_NAME" ]]
}

if name_exists; then
  name_state="exists"
elif [[ "$mode" == "check" ]]; then
  name_state="not created yet; a normal run creates it"
else
  echo "tunnel: creating zrok2 name '$TUNNEL_NAME' in namespace '$TUNNEL_NAMESPACE'..."
  if ! zrok2 create name "$TUNNEL_NAME" -n "$TUNNEL_NAMESPACE" >/dev/null 2>&1; then
    die "could not create name '$TUNNEL_NAME' (taken by another account, or the account's name limit is reached). Pick another one: TUNNEL_NAME=<name> $0"
  fi
  name_exists || die "name '$TUNNEL_NAME' was created but is not listed; check 'zrok2 list names'"
  name_state="created"
fi

base_url="https://${TUNNEL_NAME}.${ns_host}"
local_url="http://${TUNNEL_HOST}:${TUNNEL_PORT}"

# Local backend checks (warn only: the backend may be started after the tunnel).
backend_state="not checked (curl missing)"
verify_state="not checked"
if command -v curl >/dev/null 2>&1; then
  live_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${local_url}/api/health/live" || true)"
  if [[ "$live_code" == "200" ]]; then
    backend_state="reachable (${local_url}/api/health/live 200)"
    # A deliberately wrong verify token: 403 = META_WEBHOOK_VERIFY_TOKEN set, 503 = unset. Nothing secret is sent.
    verify_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      "${local_url}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=tunnel-check-wrong-token&hub.challenge=x" || true)"
    case "$verify_code" in
      403) verify_state="META_WEBHOOK_VERIFY_TOKEN is set (wrong-token probe -> 403)" ;;
      503) verify_state="META_WEBHOOK_VERIFY_TOKEN is NOT set (probe -> 503): Meta's verify step will fail" ;;
      *) verify_state="unexpected answer ${verify_code:-none} from the verify endpoint" ;;
    esac
  else
    backend_state="NOT reachable on ${local_url} (got ${live_code:-no answer}); start it: docker compose up -d (or cd backend && npm run start:dev)"
    warn "$backend_state"
  fi
fi

cat <<EOF

ShieldComment local tunnel
  zrok2 name        : ${TUNNEL_NAMESPACE}:${TUNNEL_NAME} (${name_state})
  forwards to       : ${local_url}
  local backend     : ${backend_state}
  verify token      : ${verify_state}

Public base URL     : ${base_url}
Meta app dashboard (test app):
  Webhooks callback : ${base_url}/api/webhooks/meta   (Page 'feed' + Instagram 'comments'; verify token = META_WEBHOOK_VERIFY_TOKEN)
  Deauthorize URL   : ${base_url}/api/meta/deauthorize
  Data deletion URL : ${base_url}/api/meta/data-deletion
  Health (no DB)    : ${base_url}/api/health/live
OAuth redirect (NOT through this tunnel, client origin per Module 3 D6):
  META_OAUTH_REDIRECT_URI=${CLIENT_URL}/api/meta/oauth/callback

EOF

if [[ "$mode" == "check" ]]; then
  echo "tunnel: --check done (no share started)."
  exit 0
fi

# Without a terminal the zrok2 TUI can't draw: run headless (e.g. when started in the background).
if [[ ! -t 1 ]] && [[ " ${share_args[*]-} " != *" --headless "* ]]; then
  share_args+=(--headless)
fi

echo "tunnel: starting 'zrok2 share public ${TUNNEL_HOST}:${TUNNEL_PORT} -n ${TUNNEL_NAMESPACE}:${TUNNEL_NAME}' (Ctrl-C stops it)"
# --force-local keeps the share in this process even when a zrok2 agent runs, so Ctrl-C really stops it.
exec zrok2 share public "${TUNNEL_HOST}:${TUNNEL_PORT}" -n "${TUNNEL_NAMESPACE}:${TUNNEL_NAME}" --force-local "${share_args[@]}"
