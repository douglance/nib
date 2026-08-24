#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <run-key> <review-file> [question]" >&2
  echo "Use the same run-key to resume safely; choose a new run-key for a new request." >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 64
fi

run_key="$1"
review_file="$2"
question="${3:-Reply-loop probe}"

if [[ ! "$run_key" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "run-key may contain only letters, numbers, dot, underscore, and hyphen" >&2
  exit 64
fi
if [[ ! -f "$review_file" ]]; then
  echo "Review file does not exist: $review_file" >&2
  exit 66
fi

apoc_bin="${APOC_BIN:-$(command -v apoc || true)}"
nib_bin="${NIB_BIN:-$(command -v nib || true)}"
for required in "$apoc_bin" "$nib_bin" "$(command -v jq || true)"; do
  if [[ -z "$required" || ! -x "$required" ]]; then
    echo "Required executable is unavailable: ${required:-unknown}" >&2
    exit 69
  fi
done

create_receipt="$($apoc_bin execution command "$nib_bin" \
  --idempotency-key "nib-reply-loop-$run_key-create" \
  --name "nib-reply-loop-$run_key-create" \
  --purpose "Create one durable Nib reply-loop review" \
  --timeout-ms 120000 \
  --progress-timeout-ms 60000 \
  --expect-exit-code 0 \
  --verbosity info \
  --format json \
  -- request create "$review_file" --question "$question" --format json)"

create_execution_id="$(jq -r '.id // empty' <<<"$create_receipt")"
if [[ -z "$create_execution_id" || "$(jq -r '.outcome // empty' <<<"$create_receipt")" != "passed" ]]; then
  echo "$create_receipt" >&2
  exit 1
fi

create_logs="$($apoc_bin execution logs "$create_execution_id" \
  --purpose "Read the Nib reply-loop request receipt" \
  --format json)"
request_json="$(jq -r '.stdout // empty' <<<"$create_logs")"
request_id="$(jq -r '.id // .requestId // .request_id // empty' <<<"$request_json")"
request_url="$(jq -r '.url // empty' <<<"$request_json")"
if [[ -z "$request_id" || -z "$request_url" ]]; then
  echo "Nib did not return a request ID and URL." >&2
  echo "$request_json" >&2
  exit 1
fi

wait_receipt="$($apoc_bin execution start "$nib_bin" \
  --idempotency-key "nib-reply-loop-$run_key-wait" \
  --name "nib-reply-loop-$run_key-wait" \
  --purpose "Wait durably for the Nib reply-loop response" \
  --timeout-ms 600000 \
  --progress-timeout-ms 360000 \
  --cancel-on-stall \
  --verbosity info \
  --format json \
  -- request wait "$request_id" --timeout 300 --format json)"
wait_execution_id="$(jq -r '.id // empty' <<<"$wait_receipt")"
if [[ -z "$wait_execution_id" ]]; then
  echo "$wait_receipt" >&2
  exit 1
fi

jq -n \
  --arg requestId "$request_id" \
  --arg url "$request_url" \
  --arg nativeUrl "nib://request/$request_id" \
  --arg waitExecutionId "$wait_execution_id" \
  '{
    requestId: $requestId,
    url: $url,
    nativeUrl: $nativeUrl,
    waitExecutionId: $waitExecutionId,
    inspect: [
      ("apoc execution attach " + $waitExecutionId),
      ("apoc execution logs " + $waitExecutionId)
    ]
  }'
