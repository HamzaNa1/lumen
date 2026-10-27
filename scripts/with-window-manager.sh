#!/usr/bin/env bash
set -euo pipefail
openbox >/tmp/lumen-openbox.log 2>&1 &
window_manager_pid=$!
trap 'kill "$window_manager_pid" 2>/dev/null || true' EXIT
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'; then
    "$@"
    exit $?
  fi
  if ! kill -0 "$window_manager_pid" 2>/dev/null; then
    cat /tmp/lumen-openbox.log >&2
    exit 1
  fi
  sleep 0.05
done
printf 'Window manager did not become ready\n' >&2
exit 1
