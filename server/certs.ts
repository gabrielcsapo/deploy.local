import { createPublicKey, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deployDataPath } from './data-directory.ts';

const CERTS_DIR = deployDataPath('certs');

const CA_KEY = resolve(CERTS_DIR, 'ca.key');
const CA_CERT = resolve(CERTS_DIR, 'ca.crt');
const DELEGATED_KEY = resolve(CERTS_DIR, 'issuer.key');
const DELEGATED_CERT = resolve(CERTS_DIR, 'issuer.crt');
const SERVER_KEY = resolve(CERTS_DIR, 'server.key');
const SERVER_CERT = resolve(CERTS_DIR, 'server.crt');
const SERVER_CSR = resolve(CERTS_DIR, 'server.csr');
const SERVER_CNF = resolve(CERTS_DIR, 'server.cnf');

const MAX_PEM_BYTES = 64 * 1024;

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

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function certificateSerial(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

function requirePem(value: string, label: string, type: 'CERTIFICATE' | 'CERTIFICATE REQUEST') {
  const beginnings = value?.match(new RegExp(`-----BEGIN ${type}-----`, 'g'))?.length ?? 0;
  const endings = value?.match(new RegExp(`-----END ${type}-----`, 'g'))?.length ?? 0;
  if (
    typeof value !== 'string' ||
    value.length < 64 ||
    Buffer.byteLength(value) > MAX_PEM_BYTES ||
    beginnings !== 1 ||
    endings !== 1 ||
    value.includes('PRIVATE KEY')
  ) {
    throw new Error(`${label} is not a valid PEM ${type.toLowerCase()}`);
  }
}

function publicKeyDer(value: string | Buffer): Buffer {
  return createPublicKey(value).export({ type: 'spki', format: 'der' });
}

function certificatePublicKey(path: string): Buffer {
  return publicKeyDer(openssl(['x509', '-in', path, '-pubkey', '-noout']) as Buffer);
}

function csrPublicKey(path: string): Buffer {
  return publicKeyDer(openssl(['req', '-in', path, '-pubkey', '-noout']) as Buffer);
}

function validateCsrAtPath(path: string): Buffer {
  try {
    openssl(['req', '-in', path, '-verify', '-noout']);
    const description = openssl(['req', '-in', path, '-noout', '-text'], 'utf8') as string;
    const bits = /Public-Key:\s*\((\d+) bit\)/.exec(description);
    if (!bits || Number(bits[1]) < 2048) {
      throw new Error('Suitcase intermediate CSR must use an RSA key of at least 2048 bits');
    }
    return csrPublicKey(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Suitcase intermediate CSR')) {
      throw error;
    }
    throw new Error('Suitcase intermediate CSR is invalid or has a bad signature', {
      cause: error,
    });
  }
}

function validateDelegatedMaterialAtPaths(input: {
  rootCertificate: string;
  intermediateCertificate: string;
  privateKey?: string;
}): void {
  try {
    openssl(['verify', '-CAfile', input.rootCertificate, input.rootCertificate]);
    openssl(['verify', '-CAfile', input.rootCertificate, input.intermediateCertificate]);
    openssl(['x509', '-in', input.rootCertificate, '-checkend', '86400', '-noout']);
    openssl(['x509', '-in', input.intermediateCertificate, '-checkend', '86400', '-noout']);
    const description = openssl(
      ['x509', '-in', input.intermediateCertificate, '-noout', '-text'],
      'utf8',
    ) as string;
    if (!/Basic Constraints:\s*critical[\s\S]*?CA:TRUE,\s*pathlen:0/.test(description)) {
      throw new Error('Delegated certificate must be a path-length-zero constrained CA');
    }
    if (!/Key Usage:\s*critical[\s\S]*?Certificate Sign/.test(description)) {
      throw new Error('Delegated certificate must have critical certificate-signing key usage');
    }
    if (
      !/Name Constraints:\s*critical/.test(description) ||
      !/DNS:\.local/.test(description) ||
      !/DNS:localhost/.test(description)
    ) {
      throw new Error('Delegated certificate must constrain DNS names to the local namespace');
    }
    if (input.privateKey) {
      const key = publicKeyDer(readFileSync(input.privateKey));
      const certificate = certificatePublicKey(input.intermediateCertificate);
      if (!key.equals(certificate)) {
        throw new Error('Delegated certificate does not match the suitcase private key');
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Delegated certificate')) throw error;
    throw new Error('Delegated certificate chain is invalid', { cause: error });
  }
}

function withCertificateScratch<T>(operation: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-local-certs-'));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Validate a suitcase CSR before consuming its one-time pairing code. */
export function validateSuitcaseIntermediateCsr(csr: string): void {
  checkOpenssl();
  requirePem(csr, 'Suitcase intermediate CSR', 'CERTIFICATE REQUEST');
  withCertificateScratch((directory) => {
    const path = join(directory, 'issuer.csr');
    writeFileSync(path, csr, { mode: 0o600 });
    validateCsrAtPath(path);
  });
}

/** Sign a path-length-zero suitcase issuer with Home's root CA. */
export function signSuitcaseIntermediateCertificate(csr: string): {
  rootCertificate: string;
  intermediateCertificate: string;
} {
  validateSuitcaseIntermediateCsr(csr);
  if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) {
    throw new Error('Home root certificate material is unavailable');
  }
  if (existsSync(DELEGATED_KEY) || existsSync(DELEGATED_CERT)) {
    throw new Error('A delegated suitcase cannot sign another suitcase issuer');
  }

  return withCertificateScratch((directory) => {
    const csrPath = join(directory, 'issuer.csr');
    const certificatePath = join(directory, 'issuer.crt');
    const extensionPath = join(directory, 'issuer.cnf');
    writeFileSync(csrPath, csr, { mode: 0o600 });
    const requestedPublicKey = validateCsrAtPath(csrPath);
    writeFileSync(
      extensionPath,
      `[suitcase_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
nameConstraints = critical,@suitcase_names

[suitcase_names]
permitted;DNS.1 = .local
permitted;DNS.2 = localhost
permitted;IP.1 = 10.0.0.0/255.0.0.0
permitted;IP.2 = 100.64.0.0/255.192.0.0
permitted;IP.3 = 127.0.0.0/255.0.0.0
permitted;IP.4 = 169.254.0.0/255.255.0.0
permitted;IP.5 = 172.16.0.0/255.240.0.0
permitted;IP.6 = 192.168.0.0/255.255.0.0
`,
    );
    openssl([
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      CA_CERT,
      '-CAkey',
      CA_KEY,
      '-set_serial',
      certificateSerial(),
      '-out',
      certificatePath,
      '-days',
      '1825',
      '-sha256',
      '-extfile',
      extensionPath,
      '-extensions',
      'suitcase_ca',
    ]);
    if (!requestedPublicKey.equals(certificatePublicKey(certificatePath))) {
      throw new Error('Signed suitcase intermediate does not match its CSR');
    }
    validateDelegatedMaterialAtPaths({
      rootCertificate: CA_CERT,
      intermediateCertificate: certificatePath,
    });
    return {
      rootCertificate: readFileSync(CA_CERT, 'utf8'),
      intermediateCertificate: readFileSync(certificatePath, 'utf8'),
    };
  });
}

/** Install delegated trust before the suitcase server calls ensureCerts(). */
export function installDelegatedCertificateMaterial(input: {
  rootCertificate: string;
  intermediateCertificate: string;
  privateKey: string;
}): void {
  checkOpenssl();
  requirePem(input.rootCertificate, 'Fleet root certificate', 'CERTIFICATE');
  requirePem(input.intermediateCertificate, 'Suitcase intermediate certificate', 'CERTIFICATE');
  if (
    typeof input.privateKey !== 'string' ||
    input.privateKey.length < 64 ||
    Buffer.byteLength(input.privateKey) > MAX_PEM_BYTES ||
    !input.privateKey.includes('PRIVATE KEY')
  ) {
    throw new Error('Suitcase intermediate private key is invalid');
  }

  withCertificateScratch((directory) => {
    const rootCertificate = join(directory, 'ca.crt');
    const intermediateCertificate = join(directory, 'issuer.crt');
    const privateKey = join(directory, 'issuer.key');
    writeFileSync(rootCertificate, input.rootCertificate);
    writeFileSync(intermediateCertificate, input.intermediateCertificate);
    writeFileSync(privateKey, input.privateKey, { mode: 0o600 });
    validateDelegatedMaterialAtPaths({ rootCertificate, intermediateCertificate, privateKey });
  });

  mkdirSync(CERTS_DIR, { recursive: true, mode: 0o700 });
  const changed =
    !existsSync(CA_CERT) ||
    !existsSync(DELEGATED_CERT) ||
    !existsSync(DELEGATED_KEY) ||
    readFileSync(CA_CERT, 'utf8') !== input.rootCertificate ||
    readFileSync(DELEGATED_CERT, 'utf8') !== input.intermediateCertificate ||
    readFileSync(DELEGATED_KEY, 'utf8') !== input.privateKey;
  writeFileSync(CA_CERT, input.rootCertificate, { mode: 0o644 });
  writeFileSync(DELEGATED_CERT, input.intermediateCertificate, { mode: 0o644 });
  writeFileSync(DELEGATED_KEY, input.privateKey, { mode: 0o600 });
  chmodSync(DELEGATED_KEY, 0o600);
  // A suitcase must never retain a locally generated or copied fleet root key.
  removeIfPresent(CA_KEY);
  removeIfPresent(resolve(CERTS_DIR, 'ca.srl'));
  if (changed) {
    removeIfPresent(SERVER_KEY);
    removeIfPresent(SERVER_CERT);
    removeIfPresent(SERVER_CSR);
  }
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
  ]);
  chmodSync(CA_KEY, 0o600);
}

function activeIssuer(): { certificate: string; key: string; delegated: boolean } {
  const delegated = existsSync(DELEGATED_CERT) || existsSync(DELEGATED_KEY);
  if (delegated) {
    if (!existsSync(DELEGATED_CERT) || !existsSync(DELEGATED_KEY) || !existsSync(CA_CERT)) {
      throw new Error('Delegated suitcase certificate material is incomplete');
    }
    validateDelegatedMaterialAtPaths({
      rootCertificate: CA_CERT,
      intermediateCertificate: DELEGATED_CERT,
      privateKey: DELEGATED_KEY,
    });
    if (existsSync(CA_KEY)) {
      throw new Error('Delegated suitcase must not contain the fleet root private key');
    }
    return { certificate: DELEGATED_CERT, key: DELEGATED_KEY, delegated: true };
  }
  if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) {
    throw new Error('Home root certificate material is incomplete');
  }
  return { certificate: CA_CERT, key: CA_KEY, delegated: false };
}

function generateServerCert(deploymentNames: string[] = []): void {
  const hostCount = STATIC_HOSTS.length + deploymentNames.length;
  console.log(`Generating server certificate for ${hostCount} .local hosts...`);
  const issuer = activeIssuer();
  const leafCertificate = issuer.delegated ? resolve(CERTS_DIR, 'server.leaf.crt') : SERVER_CERT;

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
    issuer.certificate,
    '-CAkey',
    issuer.key,
    '-set_serial',
    certificateSerial(),
    '-out',
    leafCertificate,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    SERVER_CNF,
    '-extensions',
    'san',
  ]);
  if (issuer.delegated) {
    writeFileSync(
      SERVER_CERT,
      `${readFileSync(leafCertificate, 'utf8').trim()}\n${readFileSync(DELEGATED_CERT, 'utf8').trim()}\n`,
    );
    removeIfPresent(leafCertificate);
  }
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

  const delegated = existsSync(DELEGATED_CERT) || existsSync(DELEGATED_KEY);
  if (!delegated) {
    if (!existsSync(CA_CERT) && !existsSync(CA_KEY)) generateCA();
    else if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) {
      throw new Error('Home root certificate material is incomplete');
    }
  }
  activeIssuer();

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
  const delegatedPresent = existsSync(DELEGATED_CERT) || existsSync(DELEGATED_KEY);
  const delegatedComplete =
    !delegatedPresent || (existsSync(DELEGATED_CERT) && existsSync(DELEGATED_KEY));
  return (
    delegatedComplete && existsSync(CA_CERT) && existsSync(SERVER_CERT) && existsSync(SERVER_KEY)
  );
}
