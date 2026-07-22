import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CLI_DIR = resolve(process.cwd(), 'dist/cli');

/**
 * GET /cli?os=<os>&arch=<arch>
 * Serves the standalone SEA binary for the requested platform.
 */
export function serveCliBinary(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const os = url.searchParams.get('os');
  const arch = url.searchParams.get('arch');

  if (!os || !arch) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing os and arch query parameters');
    return;
  }

  const binaryPath = resolve(CLI_DIR, `deploy-${os}-${arch}`);

  if (!existsSync(binaryPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`No binary available for ${os}-${arch}`);
    return;
  }

  try {
    const binary = readFileSync(binaryPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="deploy"`,
      'Content-Length': binary.length,
    });
    res.end(binary);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Failed to read CLI binary');
  }
}

/**
 * GET /install
 * Serves a shell install script that downloads and installs the deploy CLI.
 * The server URL is derived from the request Host header.
 */
export function serveInstallScript(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host || 'deploy.local';
  const serverHttpUrl = `http://${host}`;
  // Strip port for the HTTPS URL the CLI will use
  const hostname = host.split(':')[0];
  const serverHttpsUrl = `https://${hostname}`;

  const script = generateInstallScript(serverHttpUrl, serverHttpsUrl);

  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(script),
  });
  res.end(script);
}

function generateInstallScript(serverHttpUrl: string, serverHttpsUrl: string): string {
  return `#!/bin/sh
set -e

# deploy.local CLI installer
# Usage: curl -fsSL ${serverHttpUrl}/install | sh

echo "Installing deploy.local CLI..."
echo ""

# ── Detect platform ──────────────────────────────────────────────────────────

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux) ;;
  *)
    echo "Error: Unsupported OS: $OS"
    exit 1
    ;;
esac

echo "Platform: $OS-$ARCH"

# ── Download binary ──────────────────────────────────────────────────────────

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "$TMP_FILE" "${serverHttpUrl}/cli?os=$OS&arch=$ARCH" 2>/dev/null || true)"

if [ "$HTTP_CODE" != "200" ] || [ ! -s "$TMP_FILE" ]; then
  echo "Error: No binary available for $OS-$ARCH (HTTP $HTTP_CODE)"
  echo ""
  echo "Run 'pnpm build:cli' on the deploy.local server to build CLI binaries."
  exit 1
fi

chmod +x "$TMP_FILE"

# ── Install ──────────────────────────────────────────────────────────────────

INSTALL_DIR="/usr/local/bin"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

CLI_PATH="$INSTALL_DIR/deploy"
mv "$TMP_FILE" "$CLI_PATH"
# Clear the trap since we moved the file
trap - EXIT

echo "Installed to $CLI_PATH"

# ── macOS: re-sign for local execution ───────────────────────────────────────
# The CLI is cross-built on the (Linux) server, where 'codesign' is unavailable.
# postject's SEA-blob injection invalidates the Mach-O signature, and Apple
# Silicon SIGKILLs any binary with a broken/absent signature — the "zsh: killed"
# you see on first launch. Re-sign ad-hoc here on the Mac (which can always sign
# for local execution) and clear any quarantine flag.
if [ "$OS" = "darwin" ]; then
  if command -v codesign >/dev/null 2>&1; then
    if codesign --sign - --force "$CLI_PATH" >/dev/null 2>&1; then
      echo "Signed $CLI_PATH (ad-hoc)"
    else
      echo "WARNING: could not code-sign the CLI. If 'deploy' is killed on launch, run:"
      echo "  codesign --sign - --force \\"$CLI_PATH\\""
    fi
  else
    echo "WARNING: 'codesign' not found (install Xcode Command Line Tools). If"
    echo "'deploy' is killed on launch, run:  codesign --sign - --force \\"$CLI_PATH\\""
  fi
  xattr -d com.apple.quarantine "$CLI_PATH" >/dev/null 2>&1 || true
fi

# ── Configure server URL ─────────────────────────────────────────────────────

DEPLOYRC="$HOME/.deployrc"
if [ ! -f "$DEPLOYRC" ]; then
  printf '{"url":"%s"}\\n' "${serverHttpsUrl}" > "$DEPLOYRC"
  echo "Configured server: ${serverHttpsUrl}"
else
  # Update the URL in existing config, preserving other fields (credentials etc.)
  if command -v sed >/dev/null 2>&1; then
    sed -i.bak 's|"url":"[^"]*"|"url":"${serverHttpsUrl}"|' "$DEPLOYRC" 2>/dev/null && rm -f "$DEPLOYRC.bak"
    echo "Updated server URL: ${serverHttpsUrl}"
  else
    echo "Existing ~/.deployrc found, keeping current configuration."
  fi
fi

# ── PATH check ───────────────────────────────────────────────────────────────

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "NOTE: $INSTALL_DIR is not in your PATH."
    echo "Add it by running:"
    echo ""
    echo "  export PATH=\\"$INSTALL_DIR:\\$PATH\\""
    echo ""
    ;;
esac

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "deploy.local CLI installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Download the CA certificate for HTTPS:"
echo "     curl -fsSL ${serverHttpUrl}/ca.crt -o deploy-local-ca.crt"
echo "  2. Register an account:"
echo "     deploy register"
echo "  3. Deploy a project:"
echo "     cd your-project && deploy"
echo ""
`;
}
