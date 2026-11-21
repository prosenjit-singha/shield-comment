#!/usr/bin/env python3
"""Offline check of the Fly configs: no flyctl, no account calls.

Production candidate = `<app>/fly.toml` (M9-T10), staging = `<app>/fly.staging.toml` (M9-T10b, Fly Free plan).
Run from the repo root: python3 scripts/check-fly-config.py  (exit 1 + messages on a problem).
`--self-test` breaks each rule on purpose and checks that it is caught.
"""
import copy
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# app dir -> (production app name, health check path, env that must be set as is)
APPS = {
    "backend": ("shield-comment-api", "/api/health/live", {"NODE_ENV": "production", "HOST": "::", "TRUST_PROXY_HOPS": "1"}),
    "client": ("shield-comment-app", "/healthz", {"FORWARDED_FOR_MODE": "pass"}),
    "admin": ("shield-comment-admin", "/healthz", {"FORWARDED_FOR_MODE": "pass", "NGINX_RESOLVER_IPV6": "on"}),
}
FILES = {"production": "fly.toml", "staging": "fly.staging.toml"}
# Per-environment values and secrets belong in `fly secrets`, never in the committed file.
FORBIDDEN_ENV = re.compile(r"SECRET|PASSWORD|TOKEN|KEY|_URL$|URI$|ORIGINS|UPSTREAM")


def check(app: str, kind: str, conf: dict, expose: int | None) -> list[str]:
    name, health, env = APPS[app]
    svc = conf.get("http_service", {})
    checks = svc.get("checks", [])
    deploy = conf.get("deploy", {})
    errors: list[str] = []

    def need(ok: bool, what: str) -> None:
        if not ok:
            errors.append(f"{app}/{FILES[kind]}: {what}")

    need(conf.get("primary_region") == "sin", 'primary_region must be "sin"')
    need(conf.get("build", {}).get("build-target") == "runtime", 'build-target must be "runtime"')
    need(expose is not None and svc.get("internal_port") == expose, "internal_port must match the Dockerfile EXPOSE")
    need(svc.get("force_https") is True, "force_https must be true")
    need([c.get("path") for c in checks] == [health], f"one http check on {health}")
    need(all(c.get("path") != "/api/health" for c in checks), "never check /api/health (keeps Neon awake)")
    for var, value in env.items():
        need(conf.get("env", {}).get(var) == value, f"[env] {var} must be {value!r}")
    for var in conf.get("env", {}):
        need(not FORBIDDEN_ENV.search(var), f"[env] {var} is per-environment or secret: use fly secrets")

    if kind == "production" or app == "backend":
        # Always on: BullMQ workers + schedulers + Meta webhooks need the backend up.
        need(svc.get("auto_stop_machines") == "off", 'auto_stop_machines must be "off" (always on)')
        need(svc.get("min_machines_running", 0) >= 1, "min_machines_running must be >= 1")
    else:
        # Staging client/admin sleep when idle and wake on the next request (Free plan, $0).
        need(svc.get("auto_stop_machines") == "stop", 'auto_stop_machines must be "stop" on staging')
        need(svc.get("auto_start_machines") is True, "auto_start_machines must be true on staging")
        need(svc.get("min_machines_running", 0) == 0, "min_machines_running must be 0 on staging")

    if kind == "production":
        if app == "backend":
            need(deploy.get("release_command") == "node dist/db/migrate.js", 'release_command must be "node dist/db/migrate.js"')
    else:
        # Free plan: 3 machines in total, one per app; nothing may start a second one.
        need(conf.get("app") == f"{name}-staging", f'app must be "{name}-staging"')
        need("release_command" not in deploy, "no release_command on staging (it starts an extra machine; migrate per deploy.md)")
        need(deploy.get("strategy") in ("rolling", "immediate"), 'strategy must be "rolling" or "immediate" (bluegreen/canary start extra machines)')
        if app == "backend":
            need(svc.get("min_machines_running") == 1, "min_machines_running must be exactly 1 on staging")
    return errors


def load(app: str, kind: str) -> tuple[dict, int | None]:
    expose = re.search(r"^EXPOSE (\d+)", (ROOT / app / "Dockerfile").read_text(), re.M)
    conf = tomllib.loads((ROOT / app / FILES[kind]).read_text())
    return conf, int(expose.group(1)) if expose else None


def self_test() -> tuple[list[str], int]:
    # (app, kind, dotted key, broken value): each must produce at least one error.
    cases = [
        ("backend", "staging", "primary_region", "iad"),
        ("backend", "staging", "http_service.checks", [{"path": "/api/health"}]),
        ("backend", "staging", "deploy.release_command", "node dist/db/migrate.js"),
        ("backend", "staging", "deploy.strategy", "bluegreen"),
        ("backend", "staging", "http_service.min_machines_running", 2),
        ("backend", "staging", "http_service.auto_stop_machines", "stop"),
        ("backend", "staging", "env.BETTER_AUTH_URL", "https://shield-comment-api-staging.fly.dev"),
        ("backend", "staging", "app", "shield-comment-api"),
        ("client", "staging", "http_service.auto_stop_machines", "off"),
        ("client", "staging", "http_service.checks", [{"path": "/"}]),
        ("client", "staging", "env.API_UPSTREAM", "http://shield-comment-api-staging.internal:3000"),
        ("client", "staging", "deploy.strategy", "canary"),
        ("admin", "staging", "http_service.min_machines_running", 1),
        ("admin", "staging", "http_service.auto_start_machines", False),
        ("admin", "staging", "env.FORWARDED_FOR_MODE", "append"),
        ("client", "production", "http_service.auto_stop_machines", "stop"),
        ("backend", "production", "deploy.release_command", None),
    ]
    failures = []
    for app, kind, key, value in cases:
        conf, expose = load(app, kind)
        conf = copy.deepcopy(conf)
        *parents, last = key.split(".")
        node = conf
        for part in parents:
            node = node.setdefault(part, {})
        if value is None:
            node.pop(last, None)
        else:
            node[last] = value
        if not check(app, kind, conf, expose):
            failures.append(f"self-test: {app}/{FILES[kind]} {key}={value!r} was not caught")
    return failures, len(cases)


def main() -> None:
    if "--self-test" in sys.argv:
        failures, count = self_test()
        if failures:
            print("\n".join(failures))
            sys.exit(1)
        print(f"self-test OK: {count} broken configs, each caught")
        return
    errors = [e for app in APPS for kind in FILES for e in check(app, kind, *load(app, kind))]
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    print(f"fly configs OK: {', '.join(f'{app}/{f}' for app in APPS for f in FILES.values())}")


main()
