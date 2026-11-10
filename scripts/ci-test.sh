#!/bin/sh
# Desktop-user tests must not run as the container's default root account.
# Keep ownership of the worker's mounted checkout unchanged.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  exec pnpm test
fi
ci_checkout=$(mktemp -d /tmp/deploy-ci-tests.XXXXXX)
trap 'rm -rf "$ci_checkout"' EXIT HUP INT TERM
cp -a . "$ci_checkout/repository"
chown -R node:node "$ci_checkout"
# The frozen install already ran. Its store path belongs to the original user;
# do not let pnpm replace the copied, installed modules when the user changes.
runuser -u node -- env NPM_CONFIG_USERCONFIG=/dev/null pnpm_config_verify_deps_before_run=false sh -c 'cd "$1"; exec pnpm test' sh "$ci_checkout/repository"
