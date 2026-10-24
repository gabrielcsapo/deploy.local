import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalUnavailable, terminalKeys, controlInput } from './terminal-state.ts';
const ready = {
  name: 'SER',
  supported: true,
  enabled: true,
  online: true,
  locallyDisabled: false,
  recent: [],
};
test('terminal recovery states distinguish old workers, offline computers and both permission switches', () => {
  assert.equal(terminalUnavailable(ready), '');
  assert.match(terminalUnavailable({ ...ready, supported: false }), /Update deploy.local on SER/);
  assert.match(terminalUnavailable({ ...ready, online: false }), /offline/);
  assert.match(terminalUnavailable({ ...ready, enabled: false }), /disabled/);
  assert.match(terminalUnavailable({ ...ready, locallyDisabled: true }), /DEPLOY_TERMINAL=0/);
});
test('mobile extra keys send terminal escape sequences and a one-shot Control modifier', () => {
  assert.equal(controlInput('c', true), '\x03');
  assert.equal(controlInput('D', true), '\x04');
  assert.equal(controlInput('c', false), 'c');
  assert.equal(controlInput('🌍', true), '🌍');
  assert.equal(terminalKeys.find(([label]) => label === '↑')?.[1], '\x1b[A');
  assert.equal(terminalKeys.find(([label]) => label === 'Tab')?.[1], '\t');
});
