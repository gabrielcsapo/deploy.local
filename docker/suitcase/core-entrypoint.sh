#!/bin/sh
set -eu

if [ "${DEPLOY_SUITCASE_RUNTIME_PROTOCOL:-}" != "1" ]; then
  echo "Unsupported suitcase runtime protocol: ${DEPLOY_SUITCASE_RUNTIME_PROTOCOL:-unset}" >&2
  exit 64
fi

if [ -z "${DEPLOY_SUITCASE_TARGET_ID:-}" ]; then
  echo "DEPLOY_SUITCASE_TARGET_ID is required" >&2
  exit 64
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "Docker socket is missing at /var/run/docker.sock; suitcase-core cannot run sibling containers" >&2
  exit 69
fi

mkdir -p "${DEPLOY_DATA_DIR:-/var/lib/deploy.local}/content"
mkdir -p "${DEPLOY_DATA_DIR:-/var/lib/deploy.local}/build-cache"

identity_file="${DEPLOY_DATA_DIR:-/var/lib/deploy.local}/suitcase-target-id"
if [ -f "$identity_file" ]; then
  persisted_identity="$(cat "$identity_file")"
  if [ "$persisted_identity" != "$DEPLOY_SUITCASE_TARGET_ID" ]; then
    echo "Suitcase target identity mismatch: state belongs to $persisted_identity" >&2
    exit 65
  fi
else
  umask 077
  printf '%s\n' "$DEPLOY_SUITCASE_TARGET_ID" > "$identity_file"
fi

shutdown() {
  trap - TERM INT
  kill -TERM "$server_pid" "$sync_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  wait "$sync_pid" 2>/dev/null || true
}

trap 'shutdown; exit 0' TERM INT

node /opt/deploy.local/dist/suitcase-bootstrap.js
node /opt/deploy.local/dist/suitcase-sync.js &
sync_pid=$!
node /opt/deploy.local/dist/server.js "$@" &
server_pid=$!

# POSIX sh does not guarantee `wait -n`; monitor both children so a failed
# control plane or sync worker tears down the other instead of limping along.
while kill -0 "$server_pid" 2>/dev/null && kill -0 "$sync_pid" 2>/dev/null; do
  sleep 2
done

status=0
if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid" || status=$?
else
  wait "$sync_pid" || status=$?
fi
shutdown
exit "$status"
