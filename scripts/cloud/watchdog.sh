#!/usr/bin/env bash
set -euo pipefail
# Readiness can fail because upstream is down. Restart only on repeated local
# liveness failures, as measured by Docker's three-failure health check.
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' conductor-telegram-gateway 2>/dev/null || true)"
if [ "$health" = unhealthy ]; then systemctl restart conductor-telegram-gateway.service; fi
