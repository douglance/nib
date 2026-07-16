#!/bin/bash
# Stand-in for the imago `generate` subcommand, driven by env vars so
# integration tests don't spawn real generation. Speaks the same JSON
# contract nib expects on stdout: {status, out, requested, actual, matched,
# cropped, format, agyReport, waitedMs} on success; a JSON error envelope on
# non-zero exit.
#
#   FAKE_GENERATE_MODE   success (default) | error | garbage
set -u

mode="${FAKE_GENERATE_MODE:-success}"
out=""
width=0
height=0

# First arg is the subcommand ("generate"); skip it.
shift || true

while [ $# -gt 0 ]; do
	case "$1" in
	--out)
		out="$2"
		shift 2
		;;
	--width)
		width="$2"
		shift 2
		;;
	--height)
		height="$2"
		shift 2
		;;
	*)
		shift
		;;
	esac
done

case "$mode" in
success)
	base64 -d >"$out" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=
PNG
	cat <<JSON
{"status":"success","out":"$out","requested":{"width":$width,"height":$height},"actual":{"width":$width,"height":$height},"matched":true,"cropped":false,"format":"png","agyReport":"ok","waitedMs":1}
JSON
	exit 0
	;;
error)
	cat <<'JSON'
{"error":{"code":"AGY_FAILED","message":"fake generator failure"}}
JSON
	exit 1
	;;
garbage)
	echo "this response has no json shape at all"
	exit 0
	;;
*)
	echo "unknown FAKE_GENERATE_MODE: $mode" 1>&2
	exit 1
	;;
esac
