import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advertisable } from './mdns.ts';

test('loopback and unspecified addresses are never advertised on the network', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0']) assert.equal(advertisable(ip), false, ip);
  for (const ip of ['10.0.0.204', '192.168.1.20', '172.17.0.1'])
    assert.equal(advertisable(ip), true, ip);
});
