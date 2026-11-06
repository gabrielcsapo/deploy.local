// JSON.parse and base64 decoding of npm's up-to-200 MB attachment run only here.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const maxFile = 200 * 1024 * 1024;
try {
  const document = JSON.parse(await readFile(workerData.path, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Expected a package document');
  const attachments = document._attachments;
  delete document._attachments;
  if (Buffer.byteLength(JSON.stringify(document)) > 10 * 1024 * 1024)
    throw new Error('Packument too large');
  let attachment;
  if (attachments) {
    const entries = Object.entries(attachments);
    if (entries.length !== 1) throw new Error('Publish exactly one tarball');
    const [filename, value] = entries[0];
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.tgz$/.test(filename) ||
      filename.includes('..')
    )
      throw new Error('Invalid tarball filename');
    if (typeof value.data !== 'string' || value.data.length > Math.ceil(maxFile / 3) * 4)
      throw new Error('Tarball too large');
    // Buffer.from silently accepts garbage; reject non-canonical base64 first.
    if (
      value.data.length % 4 ||
      /[^A-Za-z0-9+/=]/.test(value.data) ||
      !/^[^=]*={0,2}$/.test(value.data)
    )
      throw new Error('Invalid base64 tarball');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length > maxFile || (value.length !== undefined && value.length !== bytes.length))
      throw new Error('Tarball size mismatch');
    const path = workerData.path + '.tgz';
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const sha512 = createHash('sha512'),
      sha1 = createHash('sha1');
    for await (const chunk of createReadStream(path)) {
      sha512.update(chunk);
      sha1.update(chunk);
    }
    attachment = {
      filename,
      path,
      size: bytes.length,
      integrity: 'sha512-' + sha512.digest('base64'),
      shasum: sha1.digest('hex'),
    };
  }
  parentPort.postMessage({ document, attachment });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
