#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

is_tty() {
  [ -t 0 ] && [ -t 1 ]
}

get_env_value() {
  local key="$1"
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, "", $0); print $0 }' .env | tail -n 1
}

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"

  awk -v k="$key" -v v="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^" k "=" {
      if (!updated) {
        print k "=" v;
        updated = 1;
      }
      next;
    }
    { print }
    END {
      if (!updated) {
        print k "=" v;
      }
    }
  ' .env > "$tmp_file"

  mv "$tmp_file" .env
}

is_placeholder_value() {
  local key="$1"
  local value="$2"

  if [ -z "$value" ]; then
    return 0
  fi

  case "$key:$value" in
    API_BEARER_TOKEN:change-me)
      return 0
      ;;
    AI_API_BASE_URL:*your-ai-endpoint.example*)
      return 0
      ;;
    AI_API_KEY:replace-with-real-key)
      return 0
      ;;
    WHISPER_API_URL:*your-whisper-endpoint.example*)
      return 0
      ;;
    WHISPER_API_KEY:replace-with-real-key)
      return 0
      ;;
    HUGGINGFACE_API_KEY:replace-with-real-key)
      return 0
      ;;
    S3_ENDPOINT:*'<account-id>'*)
      return 0
      ;;
    S3_ACCESS_KEY:replace-with-r2-access-key)
      return 0
      ;;
    S3_SECRET_KEY:replace-with-r2-secret-key)
      return 0
      ;;
    S3_PUBLIC_URL:*cdn.example.com*)
      return 0
      ;;
  esac

  return 1
}

prompt_env_value() {
  local key="$1"
  local prompt_text="$2"
  local default_value="$3"
  local secret="${4:-false}"
  local input

  while true; do
    if [ "$secret" = "true" ]; then
      if [ -n "$default_value" ]; then
        printf "%s [leave blank to keep current]: " "$prompt_text" >&2
      else
        printf "%s: " "$prompt_text" >&2
      fi
      read -r -s input
      printf '\n' >&2
    else
      if [ -n "$default_value" ]; then
        printf "%s [%s]: " "$prompt_text" "$default_value" >&2
      else
        printf "%s: " "$prompt_text" >&2
      fi
      read -r input
    fi

    if [ -z "$input" ]; then
      input="$default_value"
    fi

    if ! is_placeholder_value "$key" "$input"; then
      printf '%s' "$input"
      return 0
    fi

    echo "Nilai untuk $key belum valid. Isi dengan nilai nyata, bukan placeholder." >&2
  done
}

generate_token() {
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48
}

supports_compose_wait() {
  "${COMPOSE_CMD[@]}" up --help 2>/dev/null | grep -q -- '--wait'
}

wait_for_service() {
  local service="$1"
  local timeout_seconds="$2"
  local started_at
  local container_id
  local status

  started_at="$(date +%s)"

  while true; do
    container_id="$("${COMPOSE_CMD[@]}" ps -q "$service" 2>/dev/null || true)"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy|running)
          return 0
          ;;
        unhealthy|exited|dead)
          echo "Service $service gagal start dengan status: $status" >&2
          "${COMPOSE_CMD[@]}" logs "$service" --tail 100 >&2 || true
          exit 1
          ;;
      esac
    fi

    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      echo "Timeout menunggu service $service siap." >&2
      "${COMPOSE_CMD[@]}" logs "$service" --tail 100 >&2 || true
      exit 1
    fi

    sleep 2
  done
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not reachable. Start Docker first." >&2
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
touch cookies.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env created from .env.example"
  upsert_env NODE_ENV production
fi

current_token="$(get_env_value API_BEARER_TOKEN)"
if is_placeholder_value API_BEARER_TOKEN "$current_token"; then
  generated_token="$(generate_token)"
  upsert_env API_BEARER_TOKEN "$generated_token"
  echo "Generated API_BEARER_TOKEN in .env"
fi

required_keys=(
  AI_API_BASE_URL
  AI_API_KEY
  WHISPER_API_URL
  WHISPER_API_KEY
  S3_ENDPOINT
  S3_BUCKET
  S3_ACCESS_KEY
  S3_SECRET_KEY
  S3_PUBLIC_URL
)

if is_tty; then
  for key in "${required_keys[@]}"; do
    current_value="$(get_env_value "$key")"

    if ! is_placeholder_value "$key" "$current_value"; then
      continue
    fi

    case "$key" in
      AI_API_BASE_URL)
        replacement_value="$(prompt_env_value "$key" "AI API base URL" "https://ai.sumopod.com/v1")"
        ;;
      AI_API_KEY)
        replacement_value="$(prompt_env_value "$key" "AI API key" "$current_value" true)"
        ;;
      WHISPER_API_URL)
        replacement_value="$(prompt_env_value "$key" "Whisper API URL" "https://api.openai.com/v1")"
        ;;
      WHISPER_API_KEY)
        replacement_value="$(prompt_env_value "$key" "Whisper API key" "$current_value" true)"
        ;;
      S3_ENDPOINT)
        replacement_value="$(prompt_env_value "$key" "Cloudflare R2 endpoint" "$current_value")"
        ;;
      S3_BUCKET)
        replacement_value="$(prompt_env_value "$key" "Cloudflare R2 bucket" "$current_value")"
        ;;
      S3_ACCESS_KEY)
        replacement_value="$(prompt_env_value "$key" "Cloudflare R2 access key" "$current_value" true)"
        ;;
      S3_SECRET_KEY)
        replacement_value="$(prompt_env_value "$key" "Cloudflare R2 secret key" "$current_value" true)"
        ;;
      S3_PUBLIC_URL)
        replacement_value="$(prompt_env_value "$key" "Cloudflare R2 public URL / CDN URL" "$current_value")"
        ;;
    esac

    upsert_env "$key" "$replacement_value"
  done
fi

missing_keys=()
for key in "${required_keys[@]}" API_BEARER_TOKEN; do
  value="$(get_env_value "$key")"
  if is_placeholder_value "$key" "$value"; then
    missing_keys+=("$key")
  fi
done

if [ "${#missing_keys[@]}" -gt 0 ]; then
  echo "Install dibatalkan. Lengkapi nilai nyata di .env untuk: ${missing_keys[*]}" >&2
  exit 1
fi

if supports_compose_wait; then
  "${COMPOSE_CMD[@]}" up -d --build --wait redis api worker render-worker webhooks
else
  "${COMPOSE_CMD[@]}" up -d --build redis api worker render-worker webhooks
  wait_for_service redis 60
  wait_for_service api 180
fi

echo
echo "Clipper services are ready."
echo "API health: http://localhost:8080/health"
echo "Bearer token: $(get_env_value API_BEARER_TOKEN)"
echo "Status: ${COMPOSE_CMD[*]} ps"
