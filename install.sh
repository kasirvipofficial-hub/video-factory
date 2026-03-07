#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose is required but not installed." >&2
  exit 1
fi

mkdir -p temp results output assets/music assets/fonts

if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env created from .env.example"
fi

if grep -Eq 'replace-with-real-key|change-me|your-ai-endpoint\.example|cdn\.example|<account-id>' .env; then
  echo "Update .env with real API, Whisper, and R2 credentials before production use."
fi

"${COMPOSE_CMD[@]}" build
"${COMPOSE_CMD[@]}" up -d redis api worker webhooks

echo
echo "Clipper services are starting."
echo "API: http://localhost:8080/health"
echo "Status: ${COMPOSE_CMD[*]} ps"
