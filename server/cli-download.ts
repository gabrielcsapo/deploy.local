import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CLI_DIR = resolve(process.cwd(), 'dist/cli');
const MANIFEST_PATH = resolve(CLI_DIR, 'build-info.json');

export interface CliBuildManifest {
  version: string;
  packageVersion: string;
  commit: string;
  commitShort: string;
  dirty: boolean;
  buildTime: string;
  runtime: string;
  targets: Record<string, { size: number; sha256: string }>;
}

export function cliBinaryFilename(os: string, arch: string): string {
  return `deploy-${os}-${arch}${os === 'win32' ? '.exe' : ''}`;
}

/** Written by scripts/build-cli.mjs next to the binaries it stamped. */
export function readCliManifest(): CliBuildManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as CliBuildManifest;
  } catch {
    return null;
  }
}

/**
 * Routes every /cli request: the version manifest or a platform binary.
 */
export function serveCliRequest(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/cli/version') {
    serveCliVersion(res);
    return;
  }
  serveCliBinary(req, res);
}

/**
 * GET /cli/version
 * Reports which CLI build this server serves, so `deploy upgrade` can tell
 * whether the binary on the machine is the one this server would hand out.
 */
export function serveCliVersion(res: ServerResponse): void {
  const manifest = readCliManifest();

  if (!manifest) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        error: 'no-cli-build',
        message: "No CLI build available. Run 'pnpm build:cli' on the deploy.local server.",
      }),
    );
    return;
  }

  const body = JSON.stringify(manifest);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

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

  // os/arch land in a filesystem path — keep them to bare platform tokens so
  // no '..' or separator can walk out of dist/cli.
  if (!/^[a-z0-9]+$/.test(os) || !/^[a-z0-9]+$/.test(arch)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid os or arch');
    return;
  }

  const executableExtension = os === 'win32' ? '.exe' : '';
  const binaryPath = resolve(CLI_DIR, cliBinaryFilename(os, arch));

  if (!existsSync(binaryPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`No binary available for ${os}-${arch}`);
    return;
  }

  try {
    const binary = readFileSync(binaryPath);
    const manifest = readCliManifest();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="deploy${executableExtension}"`,
      'Content-Length': binary.length,
      ...(manifest
        ? {
            'X-Deploy-Cli-Version': manifest.version,
            ...(manifest.targets[`${os}-${arch}`]?.sha256
              ? { 'X-Deploy-Cli-Sha256': manifest.targets[`${os}-${arch}`].sha256 }
              : {}),
          }
        : {}),
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

/** Windows PowerShell equivalent of the POSIX one-command installer. */
export function serveWindowsInstallScript(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host || 'deploy.local';
  const serverHttpUrl = `http://${host}`;
  const hostname = host.split(':')[0];
  const serverHttpsUrl = `https://${hostname}`;
  const script = generateWindowsInstallScript(serverHttpUrl, serverHttpsUrl);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(script),
  });
  res.end(script);
}

function generateWindowsInstallScript(serverHttpUrl: string, serverHttpsUrl: string): string {
  return `$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "deploy.local"
$deployExe = Join-Path $installDir "deploy.exe"
$temporary = Join-Path $env:TEMP ("deploy-" + [guid]::NewGuid().ToString() + ".exe")

Write-Host "Installing deploy.local CLI for win32-x64..."
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "${serverHttpUrl}/cli?os=win32&arch=x64" -OutFile $temporary
  if ((Get-Item $temporary).Length -eq 0) { throw "Downloaded CLI is empty" }
  Move-Item -Force $temporary $deployExe
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $temporary
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $installDir)) {
  $nextPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
  [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
  $env:Path = "$env:Path;$installDir"
  Write-Host "Added $installDir to your user PATH."
}

$deployRc = Join-Path $HOME ".deployrc"
if (Test-Path $deployRc) {
  $configuration = Get-Content -Raw $deployRc | ConvertFrom-Json
} else {
  $configuration = [pscustomobject]@{}
}
$configuration | Add-Member -Force -NotePropertyName url -NotePropertyValue "${serverHttpsUrl}"
$configuration | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $deployRc

Write-Host "Installed $deployExe"
& $deployExe version
Write-Host "Download ${serverHttpUrl}/ca.crt and add it to Trusted Root Certification Authorities before login."
Write-Host "Next: deploy register"
`;
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
"$CLI_PATH" version 2>/dev/null || true
echo ""
echo "Later, update in place with:  deploy upgrade"
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
