import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexUsage,
  claudeUsage,
  sanitizeProviderUsage,
  readCodexUsage,
} from './provider-usage.ts';

test('Codex uses per-bucket quotas, preserves zero, and drops missing values and private fields', () => {
  const result = codexUsage(
    { account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com' } },
    {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 123 },
          secondary: { usedPercent: null },
        },
        other: {
          limitName: 'Other model',
          primary: { usedPercent: 110, windowDurationMins: 10080 },
        },
      },
    },
    100,
  );
  assert.deepEqual(result.windows, [
    { id: 'codex-primary', label: '5 hours', usedPercent: 0, resetsAt: 123 },
    { id: 'other-primary', label: 'Other model · Weekly', usedPercent: 100 },
  ]);
  assert.equal(result.status, 'signed-in');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('auth failures, signed-out, API keys and unavailable quotas stay distinct', () => {
  assert.equal(codexUsage(null, null).status, 'unavailable');
  assert.equal(codexUsage({ account: null }, null).status, 'signed-out');
  assert.deepEqual(codexUsage({ account: { type: 'apiKey' } }, null, 1), {
    id: 'codex',
    name: 'Codex',
    status: 'signed-in',
    plan: 'API key',
    windows: [],
    checkedAt: 1,
  });
  assert.equal(claudeUsage({ loggedIn: false }).status, 'signed-out');
  assert.equal(claudeUsage({ loggedIn: true }).status, 'signed-in');
  assert.equal(claudeUsage(null).status, 'unavailable');
  assert.deepEqual(claudeUsage({ loggedIn: true }).windows, []);
});
test('legacy limits work and negative percentages clamp without inventing a reset', () => {
  const result = codexUsage(
    { account: { type: 'chatgpt' } },
    { rateLimits: { primary: { usedPercent: -2, windowDurationMins: 60, resetsAt: null } } },
  );
  assert.deepEqual(result.windows, [{ id: 'codex-primary', label: '1 hour', usedPercent: 0 }]);
});
test('worker registrations retain only public provider metadata', () => {
  const result = sanitizeProviderUsage([
    {
      id: 'codex',
      status: 'signed-in',
      token: 'SECRET',
      checkedAt: 100,
      windows: [
        { id: 'x', label: 'Weekly', usedPercent: 25, secret: 'SECRET' },
        { usedPercent: null },
      ],
    },
    { id: 'claude', status: 'signed-out', windows: [{ usedPercent: 75 }] },
  ]);
  assert.equal(result[0].windows.length, 1);
  assert.equal(result[1].windows.length, 0);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(sanitizeProviderUsage(null), []);
});
test('app server reader handles split and out-of-order responses, exit and timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-usage-test-'));
  const binary = join(directory, 'codex');
  try {
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nprocess.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===0)process.stdout.write('noise\\n'+JSON.stringify({id:0,result:{}})+'\\n');if(m.id===2){const response=JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:42}}}})+'\\n'+JSON.stringify({id:1,result:{account:{type:'chatgpt',planType:'pro'}}})+'\\n';process.stdout.write(response.slice(0,20));setTimeout(()=>process.stdout.write(response.slice(20)),10);}}});`,
    );
    chmodSync(binary, 0o755);
    assert.equal((await readCodexUsage(binary)).windows[0].usedPercent, 42);
    writeFileSync(binary, '#!/usr/bin/env node\nprocess.exit(1);');
    assert.equal((await readCodexUsage(binary)).status, 'unavailable');
    writeFileSync(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000);');
    assert.equal((await readCodexUsage(binary, 100)).status, 'unavailable');
    assert.equal((await readCodexUsage(join(directory, 'missing'))).status, 'unavailable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
