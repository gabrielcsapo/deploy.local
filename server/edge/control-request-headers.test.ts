import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { controlRequestHeaders } from './control-forward.ts';

test('control forwarding preserves HTTP/2 authority and overwrites claimed scheme and address', () => {
  const headers = controlRequestHeaders({
    headers: {
      ':authority': 'registry.test:8443',
      ':scheme': 'https',
      ':path': '/npm/-/v1/login',
      'x-forwarded-proto': 'http',
      'x-forwarded-for': 'spoofed',
      connection: 'keep-alive',
      'user-agent': 'pnpm/11.1.3 npm/? node/v26 darwin arm64',
    },
    socket: { encrypted: true, remoteAddress: '::ffff:192.168.1.42' },
  } as unknown as IncomingMessage);
  assert.deepEqual(headers, {
    host: 'registry.test:8443',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '::ffff:192.168.1.42',
    'user-agent': 'pnpm/11.1.3 npm/? node/v26 darwin arm64',
  });
  const plain = controlRequestHeaders({
    headers: { host: 'registry.test:8080', 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '192.168.1.42' },
  } as unknown as IncomingMessage);
  assert.equal(plain.host, 'registry.test:8080');
  assert.equal(plain['x-forwarded-proto'], 'http');
});
