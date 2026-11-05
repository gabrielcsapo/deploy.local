import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { deployDataPath } from '../server/data-directory.ts';

export function shortFingerprint(fingerprint) {
  if (!/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(fingerprint)) {
    throw new Error('Expected a full SHA-256 certificate fingerprint.');
  }
  const bytes = fingerprint.toUpperCase().split(':');
  return `${bytes.slice(0, 6).join(':')} · ${bytes.slice(-6).join(':')}`;
}

function downloadCertificate(address) {
  const origin = new URL(address);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !['', '/'].includes(origin.pathname) ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error('Use an HTTPS coordinator address.');
  const url = new URL('/ca.crt', origin);
  return new Promise((resolve, reject) => {
    // Only public CA bytes use this transport: no credentials, cookies or redirects.
    const request = (url.protocol === 'https:' ? https.get : http.get)(
      url,
      {
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`Could not read ${url}: HTTP ${response.statusCode}`));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            request.destroy(new Error('The CA certificate exceeds 65536 bytes.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({ data: Buffer.concat(chunks), source: `Fetched from ${url}` }),
        );
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new Error('The CA certificate request timed out.')),
      20000,
    );
    request.on('close', () => clearTimeout(timeout));
    request.on('error', reject);
  });
}

export async function certificateFingerprint(address) {
  const path = deployDataPath('certs', 'ca.crt');
  let data, source;
  try {
    data = await readFile(path);
    source = `Local CA: ${path}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ({ data, source } = await downloadCertificate(address));
  }
  if (data.length > 65536) throw new Error('The CA certificate exceeds 65536 bytes.');
  const certificate = new X509Certificate(data);
  if (!certificate.ca) throw new Error('SER did not provide a CA certificate.');
  const full = certificate.fingerprint256;
  return { short: shortFingerprint(full), full, source };
}

export async function printCertificateFingerprint(address, write = console.log) {
  const result = await certificateFingerprint(address);
  write(result.short);
  write(result.full);
  write(result.source);
}
