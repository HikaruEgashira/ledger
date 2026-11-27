#!/bin/sh
# Render launchd/*.plist.in with this checkout's path, this machine's tool paths and config/config.toml values
# into ~/Library/LaunchAgents and reload. Jobs listed in config disabled_jobs are unloaded and not rendered.
# Tool paths come from LEDGER_BUN / LEDGER_GH / LEDGER_CLAUDE, else `command -v` in the installing shell.
set -eu
repo_root=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/Library/LaunchAgents"
mkdir -p "$dest" "$repo_root/logs"
need() { p=$(command -v "$1" 2>/dev/null) || { echo "install-launchd: $1 not found on PATH" >&2; exit 1; }; echo "$p"; }
bun=${LEDGER_BUN:-$(need bun)}
gh=${LEDGER_GH:-$(need gh)}
claude=${LEDGER_CLAUDE:-$(need claude)}
conf() { (cd "$repo_root/app" && "$bun" -e 'import { localConfig } from "./src/lib/org.ts"; const v = localConfig()[process.argv[1]]; console.log(Array.isArray(v) ? v.join("\n") : (v ?? ""))' "$1"); }
prefix=$(conf launchd_label_prefix)
ghtkn_read_app=$(conf ghtkn_read_app)
disabled=$(conf disabled_jobs)
[ -n "$prefix" ] && [ -n "$ghtkn_read_app" ] || { echo "install-launchd: set launchd_label_prefix and ghtkn_read_app in config/config.toml" >&2; exit 1; }
# The daily retro runs when the active window closes (default 18:00).
retro_hour=$(conf active_hours_end); [ -n "$retro_hour" ] || retro_hour=18
path="$(dirname "$gh"):$(dirname "$bun"):$(dirname "$claude"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for tmpl in "$repo_root"/launchd/*.plist.in; do
  job=$(basename "$tmpl" .plist.in)
  label="$prefix.$job"
  out="$dest/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  i=0; while launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  if printf '%s\n' "$disabled" | grep -qx "$job"; then
    rm -f "$out"
    echo "disabled $label"
    continue
  fi
  sed -e "s#@REPO_ROOT@#$repo_root#g" -e "s#@HOME@#$HOME#g" -e "s#@LABEL_PREFIX@#$prefix#g" \
    -e "s#@GHTKN_READ_APP@#$ghtkn_read_app#g" -e "s#@RETRO_HOUR@#$retro_hour#g" \
    -e "s#@BUN@#$bun#g" -e "s#@GH@#$gh#g" -e "s#@PATH@#$path#g" "$tmpl" > "$out"
  plutil -lint "$out" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$out"
  echo "loaded $label -> $out"
done
