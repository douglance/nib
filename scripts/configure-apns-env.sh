#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.prtl/server.env"

TEAM_ID="${PRTL_APNS_TEAM_ID:-${1:-}}"
KEY_ID="${PRTL_APNS_KEY_ID:-${2:-}}"
KEY_PATH="${PRTL_APNS_KEY_PATH:-${3:-}}"
TOPIC="${PRTL_APNS_TOPIC:-${4:-}}"
APNS_ENV="${PRTL_APNS_ENV:-${5:-sandbox}}"

if [[ -z "$TEAM_ID" || -z "$KEY_ID" || -z "$KEY_PATH" || -z "$TOPIC" ]]; then
  cat >&2 <<USAGE
Usage:
  PRTL_APNS_TEAM_ID=TEAM \\
  PRTL_APNS_KEY_ID=KEYID \\
  PRTL_APNS_KEY_PATH=/absolute/path/AuthKey_KEYID.p8 \\
  PRTL_APNS_TOPIC=com.example.app \\
  PRTL_APNS_ENV=sandbox \\
  scripts/configure-apns-env.sh

Or:
  scripts/configure-apns-env.sh TEAM KEYID /absolute/path/AuthKey_KEYID.p8 com.example.app sandbox
USAGE
  exit 2
fi

if [[ ! -f "$KEY_PATH" ]]; then
  echo "APNs key file does not exist: $KEY_PATH" >&2
  exit 1
fi

if [[ "$APNS_ENV" != "sandbox" && "$APNS_ENV" != "production" ]]; then
  echo "PRTL_APNS_ENV must be sandbox or production" >&2
  exit 1
fi

mkdir -p "$ROOT/.prtl"
cat > "$ENV_FILE" <<ENV
PRTL_APNS_TEAM_ID=$TEAM_ID
PRTL_APNS_KEY_ID=$KEY_ID
PRTL_APNS_KEY_PATH=$KEY_PATH
PRTL_APNS_TOPIC=$TOPIC
PRTL_APNS_ENV=$APNS_ENV
ENV

chmod 600 "$ENV_FILE"
echo "Wrote $ENV_FILE"
echo "Restart prtl with: launchctl kickstart -k gui/\\$UID/com.douglance.prtl"
