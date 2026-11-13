import { repositoryChanged } from '../git-changes.ts';
import { createGunzip } from 'node:zlib';
import { PushResult } from './pipeline-triggers.ts';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gitEnvironment } from './repository-git.ts';

export function serveRepositoryGit(
  req: IncomingMessage,
  res: ServerResponse,
  project: any,
  suffix: string,
  url: URL,
  owner: string,
) {
  const discovery =
    req.method === 'GET' &&
    suffix === '/info/refs' &&
    ['git-upload-pack', 'git-receive-pack'].includes(url.searchParams.get('service') || '');
  const rpc = req.method === 'POST' && ['/git-upload-pack', '/git-receive-pack'].includes(suffix);
  if (!discovery && !rpc)
    throw Object.assign(new Error('Unsupported Git transport route'), { status: 404 });
  const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'http-backend'], {
    env: {
      ...gitEnvironment(),
      GIT_PROJECT_ROOT: dirname(project.repositoryPath),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${project.id}.git${suffix}`,
      REQUEST_METHOD: req.method!,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: String(req.headers['content-type'] || ''),
      CONTENT_LENGTH: String(req.headers['content-length'] || ''),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] || ''),
      REMOTE_USER: owner,
      GIT_PROTOCOL: req.headers['git-protocol'] === 'version=2' ? 'version=2' : '',
    },
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const push = suffix === '/git-receive-pack' && req.method === 'POST' ? new PushResult() : null;
  if (push) {
    if (req.headers['content-encoding'] === 'gzip') {
      const unzip = createGunzip();
      unzip.on('error', () => {});
      req.pipe(unzip).on('data', (chunk) => push.commands.feed(chunk));
    } else req.on('data', (chunk) => push.commands.feed(chunk));
  }
  let header = Buffer.alloc(0),
    started = false,
    completed = false;
  const kill = () => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const fail = (message: string, status = 502) => {
    if (completed) return;
    completed = true;
    kill();
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    } else res.destroy();
  };
  const timeout = setTimeout(() => fail('Git transfer timed out', 504), 600000);
  req.on('aborted', kill);
  res.on('close', () => {
    clearTimeout(timeout);
    if (!completed) kill();
  });
  child.stdin.on('error', () => {
    /* Backend may reject before consuming the request body. */
  });
  req.pipe(child.stdin);
  child.stdout.on('data', (chunk: Buffer) => {
    if (completed) return;
    push?.feed(chunk);
    if (!started) {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) {
        if (header.length > 65536) fail('Invalid Git response headers');
        return;
      }
      if (end > 65536) return fail('Invalid Git response headers');
      let status = 200;
      for (const line of header.subarray(0, end).toString().split('\r\n')) {
        const split = line.indexOf(':');
        if (split < 0) continue;
        const key = line.slice(0, split),
          value = line.slice(split + 1).trim();
        if (key.toLowerCase() === 'status') status = parseInt(value, 10);
        else res.setHeader(key, value);
      }
      if (!Number.isInteger(status) || status < 100 || status > 599)
        return fail('Invalid Git response status');
      res.writeHead(status);
      started = true;
      chunk = header.subarray(end + 4);
      header = Buffer.alloc(0);
    }
    if (!res.write(chunk)) child.stdout.pause();
  });
  res.on('drain', () => child.stdout.resume());
  child.once('error', () => fail('Git unavailable', 503));
  child.once('close', (code) => {
    if (push) repositoryChanged(project.repositoryPath);
    clearTimeout(timeout);
    if (completed) return;
    if (code !== 0 || !started) return fail('Git transfer failed');
    completed = true;
    push?.queue(owner, project.id);
    res.end();
  });
}
