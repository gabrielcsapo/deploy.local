#!/bin/sh
# Pipeline PR jobs run in an isolated Node container, without host toolchains.
set -eu
apt-get update
apt-get install -y --no-install-recommends systemd rsync lsof
npm install --global pnpm@11.1.3
