#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NODE_ENV=production
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4070}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://doug-mm.tail5d92b4.ts.net}"

if [[ -f .prtl/server.env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .prtl/server.env
  set +a
fi

npm run build
npx tsx src/server/index.ts
