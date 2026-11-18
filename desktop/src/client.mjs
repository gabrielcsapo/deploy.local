import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

export function coordinatorOrigin(value = 'https://deploy.local') {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter the coordinator address without a path or credentials.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS. HTTP is only available on this computer for development.');
  return url.origin;
}
export function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256;
}
const current = (cert, now) => Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
export function validPin(pem, pin, now = Date.now()) {
  const cert = new X509Certificate(pem);
  return cert.fingerprint256 === pin && current(cert, now);
}
// How the coordinator's certificate compares with what this app trusts. Trust is the coordinator's
// own CA, so renewing its certificate (new apps add names to it) needs nothing from you. Macs set up
// before CA trust still hold the exact certificate's fingerprint until they move to the CA.
//   null: trusted · 'changed': signed by another CA · 'expired' · 'name': not issued for this host
export function certificateProblem(leafPem, { ca, pin } = {}, host, now = Date.now()) {
  const leaf = new X509Certificate(leafPem);
  if (!ca) return leaf.fingerprint256 !== pin ? 'changed' : current(leaf, now) ? null : 'expired';
  const authority = new X509Certificate(ca);
  if (!leaf.checkIssued(authority) || !leaf.verify(authority.publicKey)) return 'changed';
  if (!current(leaf, now) || !current(authority, now)) return 'expired';
  if (host && !(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host))) return 'name';
  return null;
}
const problems = {
  changed: [
    'CERTIFICATE_CHANGED',
    'Coordinator certificate changed. Confirm its fingerprint again.',
  ],
  expired: ['CERTIFICATE_EXPIRED', 'Coordinator certificate expired.'],
  name: ['CERTIFICATE_NAME', 'Coordinator certificate is not issued for this address.'],
};
export function certificateError(problem) {
  const [code, message] = problems[problem];
  return Object.assign(new Error(message), { code });
}
function readCa(origin) {
  return new Promise((resolve, reject) => {
    // Only the public CA bytes come over this unverified request; you confirm its fingerprint.
    const request = https.get(
      new URL('/ca.crt', origin),
      { rejectUnauthorized: false, agent: false },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
          if (data.length > 65536) response.destroy(new Error('CA certificate too large.'));
        });
        response.on('error', reject);
        response.on('end', () =>
          response.statusCode === 200 ? resolve(data) : reject(new Error('No CA certificate.')),
        );
      },
    );
    request.setTimeout(10000, () => request.destroy(new Error('Coordinator did not answer.')));
    request.on('error', reject);
  });
}
// Inspection never sends credentials. It finds the CA that signs the coordinator's certificate;
// trust still requires you to confirm that CA's fingerprint.
export async function inspectCertificate(origin) {
  const url = new URL(coordinatorOrigin(origin));
  if (url.protocol !== 'https:') return null;
  const { leaf, issuer, address } = await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: false,
    });
    socket.setTimeout(10000, () => socket.destroy(new Error('Coordinator did not answer.')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true);
      const chain = peer.issuerCertificate;
      const remote = socket.remoteAddress;
      socket.end();
      resolve({
        leaf: new X509Certificate(peer.raw),
        issuer: chain && chain !== peer ? chain.raw : null,
        address: remote,
      });
    });
  });
  const signs = (pem) => {
    try {
      const authority = new X509Certificate(pem);
      return authority.ca && leaf.checkIssued(authority) && leaf.verify(authority.publicKey)
        ? authority
        : null;
    } catch {
      return null;
    }
  };
  const authority = (issuer && signs(issuer)) || signs(await readCa(url.origin));
  if (!authority)
    throw new Error('The coordinator did not send the CA that signs its certificate.');
  return {
    fingerprint: authority.fingerprint256,
    ca: authority.toString(),
    issued: authority.validFrom,
    expires: authority.validTo,
    certificate: leaf.fingerprint256,
    subject: authority.subject,
    address,
  };
}
class TrustedAgent extends https.Agent {
  constructor(trust) {
    super({ keepAlive: false });
    this.trust = trust;
  }
  createConnection(options, callback) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    socket.setTimeout(10000, () =>
      socket.destroy(new Error('Coordinator TLS handshake timed out.')),
    );
    let done = false;
    const finish = (error) => {
      if (!done) {
        done = true;
        callback(error, error ? undefined : socket);
      }
    };
    socket.once('error', finish);
    socket.once('secureConnect', () => {
      const problem = certificateProblem(
        socket.getPeerCertificate().raw,
        this.trust,
        options.hostname || options.host,
      );
      if (problem) {
        finish(certificateError(problem));
        socket.destroy();
      } else finish(null);
    });
    // The agent releases this socket to HTTP only after the certificate check.
  }
}
export class CoordinatorClient {
  constructor(origin, { ca, pin, credentials } = {}) {
    this.origin = coordinatorOrigin(origin);
    this.ca = ca;
    this.pin = ca ? undefined : pin;
    this.credentials = credentials;
  }
  // The fingerprint this app trusts: the coordinator's CA, or for older setups its exact certificate.
  get trusted() {
    return this.ca ? fingerprint(this.ca) : this.pin;
  }
  request(path, { method = 'GET', body, timeout = 15000, headers = {}, raw = false } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Cross-origin request refused.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const auth = this.credentials
      ? { 'X-Deploy-Username': this.credentials.username, 'X-Deploy-Token': this.credentials.token }
      : {};
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method,
          agent:
            url.protocol === 'https:' && (this.ca || this.pin)
              ? new TrustedAgent({ ca: this.ca, pin: this.pin })
              : undefined,
          headers: {
            ...headers,
            ...auth,
            ...(payload ? { 'Content-Type': 'application/json' } : {}),
          },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            data += chunk;
            if (data.length > 4 * 1024 * 1024) response.destroy(new Error('Response too large.'));
          });
          response.on('error', reject);
          response.on('end', () => {
            if (response.statusCode >= 300 && response.statusCode < 400)
              return reject(new Error('Coordinator redirects are not followed.'));
            let value;
            try {
              value = raw ? data : JSON.parse(data);
            } catch {
              return reject(new Error('Coordinator returned an invalid response.'));
            }
            if (response.statusCode >= 400)
              return reject(
                Object.assign(
                  new Error(value.error || `Coordinator returned ${response.statusCode}.`),
                  { status: response.statusCode, data: value },
                ),
              );
            resolve(value);
          });
        },
      );
      request.setTimeout(timeout, () => request.destroy(new Error('Coordinator did not answer.')));
      request.on('error', reject);
      request.end(payload);
    });
  }
  async download(path, destination, { signal, size, onProgress }) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Cross-origin request refused.');
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          signal,
          agent:
            url.protocol === 'https:' && (this.ca || this.pin)
              ? new TrustedAgent({ ca: this.ca, pin: this.pin })
              : undefined,
          headers: this.credentials
            ? {
                'X-Deploy-Username': this.credentials.username,
                'X-Deploy-Token': this.credentials.token,
              }
            : {},
        },
        resolve,
      );
      request.setTimeout(30000, () => request.destroy(new Error('Download timed out.')));
      request.on('error', reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`Download returned ${response.statusCode}; redirects are not followed.`);
    }
    let bytes = 0;
    await pipeline(
      response,
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > size)
            return callback(
              Object.assign(new Error('Download size mismatch.'), { code: 'SIZE_MISMATCH' }),
            );
          onProgress(bytes);
          callback(null, chunk);
        },
      }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
  }
  async login(username, password) {
    const result = await this.request('/api/login', {
      method: 'POST',
      body: { username, password },
    });
    if (typeof result.token !== 'string' || !result.token)
      throw new Error('Sign-in did not return a token.');
    this.credentials = { username, token: result.token };
    return this.credentials;
  }
  inbox() {
    return this.request('/api/inbox?state=waiting');
  }
  async inboxSnapshot(cursor) {
    // Capture the position first: decisions arriving during the list read are replayed.
    const after = cursor ?? (await this.events('latest')).cursor;
    return { ...(await this.inbox()), cursor: after };
  }
  async live() {
    try {
      return await this.request('/api/live');
    } catch (error) {
      if ([404, 501].includes(error.status)) return null;
      throw error;
    }
  }
  async workspace() {
    return this.request('/api/state');
  }
  async computers() {
    try {
      return (await this.request('/api/computers')).computers;
    } catch (error) {
      if ([403, 404, 501].includes(error.status)) return null;
      throw error;
    }
  }
  async takeNewTasks(workerId, enabled) {
    const computer = (await this.computers())?.find((entry) => entry.workerIds.includes(workerId));
    if (!computer) throw new Error('Join this computer in Computer roles first.');
    const roles = computer.roles.filter((role) => role !== 'take-tasks');
    if (enabled) roles.push('take-tasks');
    return this.request(`/api/computers/${encodeURIComponent(computer.id)}`, {
      method: 'PATCH',
      body: { roles },
    });
  }
  events(cursor) {
    return this.request(
      `/api/activity-events?after=${encodeURIComponent(cursor)}${cursor === 'latest' ? '' : '&waitMs=10000'}`,
    );
  }
  answer(id, actionId, note) {
    return this.request(`/api/inbox/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: { actionId, on: 'desktop', ...(note === undefined ? {} : { note }) },
    });
  }
}
