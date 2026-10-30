import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deployDataPath } from './data-directory.ts';

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

/**
 * Where the CLI builds this server hands out live. A release serves its own
 * `dist/cli` when builds were copied into it; `<data>/cli` outlives releases, so
 * a release shipped without builds keeps serving the last ones. The newer wins.
 */
export function cliDirectory(
  candidates = [resolve(process.cwd(), 'dist/cli'), deployDataPath('cli')],
): string {
  let chosen = candidates[0];
  let newest = '';
  for (const directory of candidates) {
    const built = readCliManifest(directory)?.buildTime ?? '';
    if (built > newest) {
      newest = built;
      chosen = directory;
    }
  }
  return chosen;
}

/** Written by scripts/build-cli.mjs next to the binaries it stamped. */
export function readCliManifest(directory = cliDirectory()): CliBuildManifest | null {
  try {
    return JSON.parse(
      readFileSync(resolve(directory, 'build-info.json'), 'utf-8'),
    ) as CliBuildManifest;
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
        message:
          "No CLI build available. Run 'pnpm build:cli' and copy dist/cli to cli/ in the server's data directory.",
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
export function serveCliBinary(
  req: IncomingMessage,
  res: ServerResponse,
  directory = cliDirectory(),
): void {
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
  const binaryPath = resolve(directory, cliBinaryFilename(os, arch));

  if (!existsSync(binaryPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`No binary available for ${os}-${arch}`);
    return;
  }

  try {
    const binary = readFileSync(binaryPath);
    const manifest = readCliManifest(directory);
    const target = manifest?.targets[`${os}-${arch}`];
    if (
      !manifest ||
      !target ||
      (url.searchParams.has('version') && url.searchParams.get('version') !== manifest.version) ||
      binary.length !== target.size ||
      createHash('sha256').update(binary).digest('hex') !== target.sha256
    ) {
      res.writeHead(409, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Worker build does not match its manifest. Try again after the release completes.');
      return;
    }
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
  const requestedHost = req.headers.host || 'deploy.local';
  const host = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(requestedHost) ? requestedHost : 'deploy.local';
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
  const requestedHost = req.headers.host || 'deploy.local';
  const host = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(requestedHost) ? requestedHost : 'deploy.local';
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
Write-Host "Next: finish the first account at https://deploy.local/setup with the code printed on SER, then deploy login."
`;
}

export function generateInstallScript(
  serverHttpUrl: string,
  serverHttpsUrl: string,
  manifest = readCliManifest(),
): string {
  const checksums = Object.entries(manifest?.targets || {})
    .filter(
      ([target, info]) =>
        /^(darwin|linux)-(arm64|x64)$/.test(target) && /^[a-f0-9]{64}$/.test(info.sha256),
    )
    .map(([target, info]) => `  ${target}) EXPECTED="${info.sha256}" ;;`)
    .join('\n');
  // Only a plain build version goes into the script's quoted comparison.
  const currentVersion = /^[\w.+-]+$/.test(manifest?.version ?? '') ? manifest!.version : '';
  return `#!/bin/sh
set -e

# deploy.local CLI installer
# Usage: curl -fsSL ${serverHttpUrl}/install | sh
# Add a computer: curl -fsSL ${serverHttpUrl}/install | sh -s -- --join <code>

JOIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --join)
      if [ $# -lt 2 ]; then echo "Add the join code after --join."; exit 1; fi
      JOIN="$2"
      shift 2
      ;;
    --join=*) JOIN="$(printf '%s' "$1" | cut -d= -f2-)"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
case "$JOIN" in
  *[!A-Za-z0-9_-]*) echo "That join code doesn't look right. Copy the command again from Add a computer."; exit 1 ;;
esac

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

# Joining keeps a CLI that already matches this coordinator's build.
CURRENT=""
EXISTING="$(command -v deploy 2>/dev/null || true)"
if [ -n "$JOIN" ] && [ -n "$EXISTING" ] && [ -n "${currentVersion}" ] &&
  "$EXISTING" version --json 2>/dev/null | grep -qF '"${currentVersion}"'; then
  CURRENT=1
  CLI_PATH="$EXISTING"
  echo "The deploy.local CLI is already installed and current."
fi

if [ -z "$CURRENT" ]; then

case "$OS-$ARCH" in
${checksums}
  *) echo "No matching worker build is available on the coordinator."; exit 1 ;;
esac
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "$TMP_FILE" "${serverHttpUrl}/cli?os=$OS&arch=$ARCH" 2>/dev/null || true)"

if [ "$HTTP_CODE" != "200" ] || [ ! -s "$TMP_FILE" ]; then
  echo "Error: No binary available for $OS-$ARCH (HTTP $HTTP_CODE)"
  echo ""
  echo "Run 'pnpm build:cli' on the deploy.local server to build CLI binaries."
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP_FILE" | cut -d ' ' -f 1)"
else
  ACTUAL="$(shasum -a 256 "$TMP_FILE" | cut -d ' ' -f 1)"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Worker checksum mismatch. Nothing was installed; fetch /install again."
  exit 1
fi
chmod +x "$TMP_FILE"
if [ "$OS" = "darwin" ]; then
  codesign --sign - --force "$TMP_FILE"
fi
"$TMP_FILE" version --json >/dev/null

# ── Install ──────────────────────────────────────────────────────────────────

INSTALL_DIR="/usr/local/bin"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

CLI_PATH="$INSTALL_DIR/deploy"
# Copy to the destination filesystem before the atomic rename.
STAGED="$INSTALL_DIR/.deploy-install-$$"
trap 'rm -f "$TMP_FILE" "$STAGED"' EXIT
cp "$TMP_FILE" "$STAGED"
chmod 755 "$STAGED"
mv "$STAGED" "$CLI_PATH"
rm -f "$TMP_FILE"
# Clear the trap since we moved the file
trap - EXIT

echo "Installed to $CLI_PATH"
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

# ── Join ─────────────────────────────────────────────────────────────────────

if [ -n "$JOIN" ]; then
  echo ""
  echo "Joining ${serverHttpsUrl}..."
  if [ "$OS" = "linux" ] && [ "$(id -u)" != "0" ]; then
    sudo env DEPLOY_JOIN_CODE="$JOIN" "$CLI_PATH" computer join "${serverHttpsUrl}"
  else
    DEPLOY_JOIN_CODE="$JOIN" "$CLI_PATH" computer join "${serverHttpsUrl}"
  fi
  exit 0
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "deploy.local CLI installed successfully!"
"$CLI_PATH" version 2>/dev/null || true
echo ""
echo "Later, update in place with:  deploy upgrade"
echo "Add this computer: deploy computer join ${serverHttpsUrl} (sudo on Linux)"
echo "Windows computers use the desktop app."
echo ""
echo "Next steps:"
echo "  1. Download the CA certificate for HTTPS:"
echo "     curl -fsSL ${serverHttpUrl}/ca.crt -o deploy-local-ca.crt"
echo "  2. Sign in:"
echo "     deploy login"
echo "     First account? Open ${serverHttpsUrl}/setup with the setup code printed on SER."
echo "  3. Deploy a project:"
echo "     cd your-project && deploy"
echo ""
`;
}
