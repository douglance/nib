#!/bin/bash
# Stand-in for the imago `compare` subcommand, driven by env vars so
# integration tests don't spawn a real judge call. Speaks the same JSON
# verdict contract nib expects on stdout: {verdict, blockers, polish,
# review, retried}.
#
#   FAKE_JUDGE_MODE   ready (default) | blocked | garbage | error
set -u

mode="${FAKE_JUDGE_MODE:-ready}"

case "$mode" in
ready)
	echo '{"verdict":"READY","blockers":[],"polish":[],"review":"looks good","retried":false}'
	exit 0
	;;
blocked)
	echo '{"verdict":"BLOCKED","blockers":["logo clipped on the right edge"],"polish":[],"review":"needs fix","retried":false}'
	exit 0
	;;
garbage)
	echo "this response has no json shape at all"
	exit 0
	;;
error)
	echo '{"error":{"code":"TOOL_FAILED","message":"fake judge failure"}}'
	exit 1
	;;
*)
	echo "unknown FAKE_JUDGE_MODE: $mode" 1>&2
	exit 1
	;;
esac
