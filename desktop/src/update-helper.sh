#!/bin/sh
# All paths are positional arguments, never evaluated as shell source.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
pid=$1
bundle=$2
candidate=$3
backup=$4
receipt=$5
token=$6
data=$7
launcher=$8
limit=${9:-60}
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 120 ]; then echo 'The app did not quit; no swap performed.'; exit 1; fi
  sleep 1
done
reopen() {
  "$launcher" -n "$bundle" --args "--deploy-data-dir=$data" "$@"
}
rollback() {
  # The startup and rollback paths claim the same directory, so only one can win.
  if ! mkdir "$receipt.claim" 2>/dev/null; then
    [ -f "$receipt.ok" ] && exit 0
    echo 'Startup owns the handoff; keeping the backup for recovery.'
    exit 1
  fi
  if [ -f "$receipt.pid" ]; then
    newpid=$(cat "$receipt.pid")
    case "$newpid" in ''|*[!0-9]*) ;; *)
      kill "$newpid" 2>/dev/null || true
      count=0
      while kill -0 "$newpid" 2>/dev/null; do
        count=$((count + 1))
        if [ "$count" -ge 10 ]; then kill -9 "$newpid" 2>/dev/null || true; break; fi
        sleep 1
      done ;;
    esac
  fi
  if [ -d "$backup" ]; then
    if [ -e "$bundle" ]; then mv "$bundle" "$candidate.failed" || exit 1; fi
    mv "$backup" "$bundle" || exit 1
  fi
  echo 'Restored the previous app.'
  reopen "--deploy-update-rollback=$token"
  exit 1
}
if ! mv "$bundle" "$backup"; then
  echo 'Could not move the installed app; reopening it.'
  reopen "--deploy-update-rollback=$token"
  exit 1
fi
mv "$candidate" "$bundle" || rollback
reopen "--deploy-update=$token" || rollback
count=0
while [ ! -f "$receipt.ok" ]; do
  count=$((count + 1))
  [ "$count" -ge "$limit" ] && rollback
  sleep 1
done
# The new app removes the backup after acknowledging a successful startup.
exit 0
