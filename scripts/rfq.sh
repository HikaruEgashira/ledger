#!/usr/bin/env bash
# Query the local store with DuckDB: scripts/rfq.sh "SELECT ..."  (no argument opens the DuckDB shell)
set -euo pipefail
db="$(cd "$(dirname "$0")/.." && pwd)/review-factory.db"
duck() { duckdb -light-mode "$@"; }

# DuckDB fetches extensions over plain http, which the proxy rejects; fetch over https with curl and install from the file.
if [ "$(duck -csv -noheader -c "SELECT installed FROM duckdb_extensions() WHERE extension_name = 'sqlite_scanner'")" != "true" ]; then
  read -r ver plat < <(duck -csv -noheader -separator ' ' -c "SELECT library_version, (SELECT platform FROM pragma_platform()) FROM pragma_version()")
  tmp="$(mktemp -d)"
  curl -fsSL "https://extensions.duckdb.org/${ver}/${plat}/sqlite_scanner.duckdb_extension.gz" | gunzip > "$tmp/sqlite_scanner.duckdb_extension"
  duck -c "INSTALL '$tmp/sqlite_scanner.duckdb_extension'"
  rm -rf "$tmp"
fi

init="LOAD sqlite; ATTACH '$db' AS rf (TYPE sqlite, READ_ONLY); USE rf;"
if [ $# -eq 0 ]; then exec duckdb -light-mode -cmd "$init"; fi
exec duckdb -light-mode -c "$init $1"
