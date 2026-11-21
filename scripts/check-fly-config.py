#!/usr/bin/env python3
"""Offline check of the three fly.toml files (M9-T10): no flyctl, no account calls.

Run from the repo root: python3 scripts/check-fly-config.py  (exit 1 + messages on a problem).
"""
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# app dir -> (health check path, env that must be set as is)
APPS = {
    "backend": ("/api/health/live", {"NODE_ENV": "production", "HOST": "::", "TRUST_PROXY_HOPS": "1"}),
    "client": ("/healthz", {"FORWARDED_FOR_MODE": "pass"}),
    "admin": ("/healthz", {"FORWARDED_FOR_MODE": "pass", "NGINX_RESOLVER_IPV6": "on"}),
}
# Per-environment values and secrets belong in `fly secrets`, never in the shared file.
FORBIDDEN_ENV = re.compile(r"SECRET|PASSWORD|TOKEN|KEY|_URL$|URI$|ORIGINS|UPSTREAM")

errors: list[str] = []
for app, (health, env) in APPS.items():
    conf = tomllib.loads((ROOT / app / "fly.toml").read_text())
    expose = re.search(r"^EXPOSE (\d+)", (ROOT / app / "Dockerfile").read_text(), re.M)
    svc = conf.get("http_service", {})
    checks = svc.get("checks", [])

    def need(ok: bool, what: str) -> None:
        if not ok:
            errors.append(f"{app}/fly.toml: {what}")

    need(conf.get("primary_region") == "sin", 'primary_region must be "sin"')
    need(conf.get("build", {}).get("build-target") == "runtime", 'build-target must be "runtime"')
    need(expose is not None and svc.get("internal_port") == int(expose.group(1)), "internal_port must match the Dockerfile EXPOSE")
    need(svc.get("force_https") is True, "force_https must be true")
    need(svc.get("auto_stop_machines") == "off", 'auto_stop_machines must be "off" (always on)')
    need(svc.get("min_machines_running", 0) >= 1, "min_machines_running must be >= 1")
    need([c.get("path") for c in checks] == [health], f"one http check on {health}")
    need(all(c.get("path") != "/api/health" for c in checks), "never check /api/health (keeps Neon awake)")
    for name, value in env.items():
        need(conf.get("env", {}).get(name) == value, f"[env] {name} must be {value!r}")
    for name in conf.get("env", {}):
        need(not FORBIDDEN_ENV.search(name), f"[env] {name} is per-environment or secret: use fly secrets")

backend = tomllib.loads((ROOT / "backend/fly.toml").read_text())
if backend.get("deploy", {}).get("release_command") != "node dist/db/migrate.js":
    errors.append('backend/fly.toml: release_command must be "node dist/db/migrate.js"')

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"fly.toml OK: {', '.join(APPS)}")
