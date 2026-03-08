#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/temp /app/results /app/output /app/assets/music /app/assets/fonts

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

if [ "${REQUIRE_COMPLETE_ENV:-true}" = "true" ]; then
  required_keys=(
    API_BEARER_TOKEN
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

  missing_keys=()
  for key in "${required_keys[@]}"; do
    value="${!key:-}"
    if is_placeholder_value "$key" "$value"; then
      missing_keys+=("$key")
    fi
  done

  if [ "${#missing_keys[@]}" -gt 0 ]; then
    echo "Container startup aborted. Set real values for: ${missing_keys[*]}" >&2
    exit 1
  fi
fi

exec "$@"