#!/bin/sh
# Run the command only inside active_hours_start..active_hours_end (config.toml or ACTIVE_HOURS_* env); unset means always.
# --hold keeps a long-running command alive inside the window for KeepAlive jobs.
set -eu
cfg=${ACTIVE_HOURS_CONFIG:-"$(cd "$(dirname "$0")/.." && pwd)/config/config.toml"}
conf() { [ -f "$cfg" ] && sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"#]*\)\"\{0,1\}.*/\1/p" "$cfg" | head -1 | tr -d ' ' || true; }
start=${ACTIVE_HOURS_START:-$(conf active_hours_start)}
end=${ACTIVE_HOURS_END:-$(conf active_hours_end)}
tz=${ACTIVE_HOURS_TZ:-$(conf active_hours_tz)}
if [ -z "$start" ] || [ -z "$end" ]; then
  [ "${1:-}" = "--hold" ] && shift
  exec "$@"
fi
active() { h=$(TZ=${tz:-UTC} date +%H); h=${h#0}; [ "$h" -ge "$start" ] && [ "$h" -lt "$end" ]; }

if [ "${1:-}" != "--hold" ]; then
  active || exit 0
  exec "$@"
fi
shift
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
while :; do
  while ! active; do sleep 60; done
  "$@" &
  child=$!
  while active && kill -0 "$child" 2>/dev/null; do sleep 60; done
  if kill -0 "$child" 2>/dev/null; then
    echo "active-hours: outside ${start}:00-${end}:00 ${tz:-UTC}, stopping" >&2
    kill "$child"
  fi
  wait "$child" || sleep 10
  child=
done
