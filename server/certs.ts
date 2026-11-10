import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { deployDataPath } from './data-directory.ts';

const CERTS_DIR = deployDataPath('certs');

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
  const dnsEntries = new Set<string>();
  dnsEntries.add('DNS:localhost');
  for (const name of STATIC_HOSTS) dnsEntries.add(`DNS:${name}.local`);
  for (const name of deploymentNames) dnsEntries.add(`DNS:${name}.local`);

  const ipEntries = new Set<string>();
  ipEntries.add('IP:127.0.0.1');
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) ipEntries.add(`IP:${iface.address}`);
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
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${sanEntries}
`;
}

function checkOpenssl(): void {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
  } catch {
    throw new Error('openssl is required but not found. Please install openssl.');
  }
}

function openssl(args: string[], encoding?: BufferEncoding): Buffer | string {
  return execFileSync('openssl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding,
  });
}

function certificateSerial(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

function generateCA(): void {
  console.log('Generating local CA...');
  openssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    CA_KEY,
    '-out',
    CA_CERT,
    '-days',
    '3650',
    '-subj',
    '/CN=deploy.local CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'subjectKeyIdentifier=hash',
    '-addext',
    'authorityKeyIdentifier=keyid:always',
  ]);
  chmodSync(CA_KEY, 0o600);
}

function generateServerCert(deploymentNames: string[] = []): void {
  const hostCount = STATIC_HOSTS.length + deploymentNames.length;
  console.log(`Generating server certificate for ${hostCount} .local hosts...`);

  writeFileSync(SERVER_CNF, buildSanConfig(deploymentNames));
  openssl(['genrsa', '-out', SERVER_KEY, '2048']);
  chmodSync(SERVER_KEY, 0o600);
  openssl(['req', '-new', '-key', SERVER_KEY, '-out', SERVER_CSR, '-config', SERVER_CNF]);
  openssl([
    'x509',
    '-req',
    '-in',
    SERVER_CSR,
    '-CA',
    CA_CERT,
    '-CAkey',
    CA_KEY,
    '-set_serial',
    certificateSerial(),
    '-out',
    SERVER_CERT,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    SERVER_CNF,
    '-extensions',
    'san',
  ]);
}

function isExpiringSoon(): boolean {
  if (!existsSync(SERVER_CERT)) return true;
  try {
    const endDateStr = (
      openssl(['x509', '-enddate', '-noout', '-in', SERVER_CERT], 'utf8') as string
    ).trim();
    const expiryDate = new Date(endDateStr.replace('notAfter=', ''));
    return expiryDate <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } catch {
    return true;
  }
}

function getCertSanNames(): Set<string> {
  if (!existsSync(SERVER_CERT)) return new Set();
  try {
    const out = openssl(['x509', '-in', SERVER_CERT, '-noout', '-ext', 'subjectAltName'], 'utf8');
    const names = new Set<string>();
    for (const match of (out as string).matchAll(/DNS:([^\s,]+)/g)) names.add(match[1]);
    return names;
  } catch {
    return new Set();
  }
}

export function ensureCerts(deploymentNames: string[] = []): void {
  checkOpenssl();
  if (!existsSync(CERTS_DIR)) mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });

  if (!existsSync(CA_CERT) && !existsSync(CA_KEY)) generateCA();
  else if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) {
    throw new Error('Home root certificate material is incomplete');
  }

  if (!existsSync(SERVER_CERT) || !existsSync(SERVER_KEY) || isExpiringSoon()) {
    generateServerCert(deploymentNames);
  }
}

export function ensureCertCoversHost(name: string, allDeploymentNames: string[]): boolean {
  const hostname = `${name}.local`;
  if (getCertSanNames().has(hostname)) return false;
  console.log(`Regenerating server cert to include ${hostname}...`);
  generateServerCert(allDeploymentNames);
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
