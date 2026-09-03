#!/bin/sh
set -eu

exec node -e '
const tls = require("node:tls");
const socket = tls.connect({ host: "127.0.0.1", port: Number(process.env.HTTPS_PORT || 443), rejectUnauthorized: false });
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 2000);
socket.once("secureConnect", () => { clearTimeout(timer); socket.end(); process.exit(0); });
socket.once("error", () => { clearTimeout(timer); process.exit(1); });
'

