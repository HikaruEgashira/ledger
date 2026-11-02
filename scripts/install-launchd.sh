#!/bin/sh
# Render launchd/*.plist.in with this checkout's path and config/config.toml values into ~/Library/LaunchAgents and reload; disabled/ is skipped.
set -eu
repo_root=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/Library/LaunchAgents"
mkdir -p "$dest" "$repo_root/logs"
conf() { (cd "$repo_root/app" && bun -e 'import { localConfig } from "./src/lib/org.ts"; console.log(localConfig()[process.argv[1]])' "$1"); }
prefix=$(conf launchd_label_prefix)
ghtkn_read_app=$(conf ghtkn_read_app)
for tmpl in "$repo_root"/launchd/*.plist.in; do
  label="$prefix.$(basename "$tmpl" .plist.in)"
  out="$dest/$label.plist"
  sed -e "s#@REPO_ROOT@#$repo_root#g" -e "s#@HOME@#$HOME#g" -e "s#@LABEL_PREFIX@#$prefix#g" -e "s#@GHTKN_READ_APP@#$ghtkn_read_app#g" "$tmpl" > "$out"
  plutil -lint "$out" >/dev/null
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$out"
  echo "loaded $label -> $out"
done
