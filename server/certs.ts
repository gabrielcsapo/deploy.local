import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { Server as HttpsServer } from 'node:https';

const DATA_DIR = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
const CERTS_DIR = resolve(DATA_DIR, 'certs');

const CA_KEY = resolve(CERTS_DIR, 'ca.key');
const CA_CERT = resolve(CERTS_DIR, 'ca.crt');
const SERVER_KEY = resolve(CERTS_DIR, 'server.key');
const SERVER_CERT = resolve(CERTS_DIR, 'server.crt');
const SERVER_CSR = resolve(CERTS_DIR, 'server.csr');
const SERVER_CNF = resolve(CERTS_DIR, 'server.cnf');

// Apple rejects *.local wildcard certs (requires 2+ labels after wildcard).
// We must list each hostname explicitly in the SAN.
const STATIC_HOSTS = ['deploy', 'discover'];

function buildSanConfig(deploymentNames: string[] = []): string {
  // Explicit DNS entries for each known host (Apple won't accept *.local)
  const dnsEntries = new Set<string>();
  dnsEntries.add('DNS:localhost');
  for (const name of STATIC_HOSTS) {
    dnsEntries.add(`DNS:${name}.local`);
  }
  for (const name of deploymentNames) {
    dnsEntries.add(`DNS:${name}.local`);
  }

  // Include all non-internal IPv4 addresses
  const ipEntries = new Set<string>();
  ipEntries.add('IP:127.0.0.1');
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ipEntries.add(`IP:${iface.address}`);
      }
    }
  }

  const sanEntries = [...dnsEntries, ...ipEntries].join(',');
  return `[req]
default_bits = 2048
prompt = no
distinguished_name = dn
req_extensions = san

[dn]
CN = deploy.local

[san]
subjectAltName = ${sanEntries}
`;
}

function checkOpenssl(): void {
  try {
    execSync('openssl version', { stdio: 'pipe' });
  } catch {
    console.error('openssl is required but not found. Please install openssl.');
    process.exit(1);
  }
}

function generateCA(): void {
  console.log('Generating local CA...');
  execSync(
    `openssl req -x509 -new -nodes -newkey rsa:2048 -keyout "${CA_KEY}" -out "${CA_CERT}" -days 3650 -subj "/CN=deploy.local CA"`,
    { stdio: 'pipe' },
  );
}

function generateServerCert(deploymentNames: string[] = []): void {
  const hostCount = STATIC_HOSTS.length + deploymentNames.length;
  console.log(`Generating server certificate for ${hostCount} .local hosts...`);

  // Write SAN config with current deployment names + network IPs
  writeFileSync(SERVER_CNF, buildSanConfig(deploymentNames));

  // Generate server key
  execSync(`openssl genrsa -out "${SERVER_KEY}" 2048`, { stdio: 'pipe' });

  // Generate CSR
  execSync(`openssl req -new -key "${SERVER_KEY}" -out "${SERVER_CSR}" -config "${SERVER_CNF}"`, {
    stdio: 'pipe',
  });

  // Sign with CA (825 days — Apple's maximum)
  execSync(
    `openssl x509 -req -in "${SERVER_CSR}" -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial -out "${SERVER_CERT}" -days 825 -extfile "${SERVER_CNF}" -extensions san`,
    { stdio: 'pipe' },
  );
}

function isExpiringSoon(): boolean {
  if (!existsSync(SERVER_CERT)) return true;
  try {
    const endDateStr = execSync(`openssl x509 -enddate -noout -in "${SERVER_CERT}"`, {
      encoding: 'utf-8',
    }).trim();
    // Format: notAfter=Mar  6 00:00:00 2028 GMT
    const dateStr = endDateStr.replace('notAfter=', '');
    const expiryDate = new Date(dateStr);
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return expiryDate <= thirtyDaysFromNow;
  } catch {
    return true;
  }
}

/** Get the list of DNS names currently in the server cert's SAN. */
function getCertSanNames(): Set<string> {
  if (!existsSync(SERVER_CERT)) return new Set();
  try {
    const out = execSync(
      `openssl x509 -in "${SERVER_CERT}" -noout -ext subjectAltName 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    const names = new Set<string>();
    const matches = out.matchAll(/DNS:([^\s,]+)/g);
    for (const m of matches) {
      names.add(m[1]);
    }
    return names;
  } catch {
    return new Set();
  }
}

export function ensureCerts(deploymentNames: string[] = []): void {
  checkOpenssl();

  if (!existsSync(CERTS_DIR)) {
    mkdirSync(CERTS_DIR, { recursive: true });
  }

  // Generate CA if missing
  if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) {
    generateCA();
  }

  // Generate server cert if missing or expiring soon
  if (!existsSync(SERVER_CERT) || !existsSync(SERVER_KEY) || isExpiringSoon()) {
    generateServerCert(deploymentNames);
  }
}

/**
 * Regenerate the server cert to include a new deployment name.
 * Returns true if the cert was regenerated (caller should reload TLS context).
 */
export function ensureCertCoversHost(
  name: string,
  allDeploymentNames: string[],
  httpsServer?: HttpsServer,
): boolean {
  const hostname = `${name}.local`;
  const currentSans = getCertSanNames();
  if (currentSans.has(hostname)) return false;

  console.log(`Regenerating server cert to include ${hostname}...`);
  generateServerCert(allDeploymentNames);

  // Hot-reload the TLS context so existing connections aren't disrupted
  if (httpsServer) {
    const opts = getTlsOptions();
    httpsServer.setSecureContext({ key: opts.key, cert: opts.cert, ca: opts.ca });
    console.log('TLS context reloaded');
  }

  return true;
}

export function getTlsOptions(): { key: Buffer; cert: Buffer; ca: Buffer } {
  return {
    key: readFileSync(SERVER_KEY),
    cert: readFileSync(SERVER_CERT),
    ca: readFileSync(CA_CERT),
  };
}

export function getCaCertBuffer(): Buffer {
  return readFileSync(CA_CERT);
}

export function certsExist(): boolean {
  return existsSync(CA_CERT) && existsSync(SERVER_CERT) && existsSync(SERVER_KEY);
}
