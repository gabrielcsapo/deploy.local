#!/bin/sh
set -eu

if [ "${DEPLOY_SUITCASE_RUNTIME_PROTOCOL:-}" != "1" ]; then
  echo "Unsupported suitcase runtime protocol: ${DEPLOY_SUITCASE_RUNTIME_PROTOCOL:-unset}" >&2
  exit 64
fi

require_managed_path() {
  case "$1" in
    /var/lib/deploy.local|/var/lib/deploy.local/*) ;;
    *) echo "Path must be inside /var/lib/deploy.local: $1" >&2; exit 64 ;;
  esac
}

command="${1:-help}"
case "$command" in
  health)
    echo '{"ok":true,"runtimeProtocol":"1"}'
    ;;
  snapshot)
    source_path="${2:?snapshot requires a source path}"
    archive_path="${3:?snapshot requires an archive path}"
    require_managed_path "$source_path"
    require_managed_path "$archive_path"
    test -d "$source_path"
    mkdir -p "$(dirname "$archive_path")"
    tar -C "$source_path" -cf - . | zstd -T0 -q -o "$archive_path"
    sha256sum "$archive_path"
    ;;
  checksum)
    content_path="${2:?checksum requires a path}"
    require_managed_path "$content_path"
    if [ -d "$content_path" ]; then
      find "$content_path" -type f -print0 | sort -z | xargs -0 sha256sum
    else
      sha256sum "$content_path"
    fi
    ;;
  sqlite-inspect)
    database_path="${2:?sqlite-inspect requires a database path}"
    require_managed_path "$database_path"
    sqlite3 -json "$database_path" \
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;"
    ;;
  help)
    echo "Usage: suitcase-volume-helper <health|snapshot|checksum|sqlite-inspect> [arguments...]"
    ;;
  *)
    echo "Unknown helper command: $command" >&2
    exit 64
    ;;
esac

