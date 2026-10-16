import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('picker discovers the runtime catalog, follows pagination, and excludes hidden models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-catalog-'));
  const binary = join(dir, 'codex');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  const reply = result => console.log(JSON.stringify({ id: m.id, result }));
  if (m.method === 'initialize') reply({});
  if (m.method === 'model/list') reply({
    data: m.params.cursor ? [{ model:'other', displayName:'Other', supportedReasoningEfforts:[] }] : [
      { model:'available', displayName:'Available', supportedReasoningEfforts:[{reasoningEffort:'high'}] },
      { model:'hidden', displayName:'Hidden', hidden:true }
    ], nextCursor: m.params.cursor ? null : 'next'
  });
});`,
    { mode: 0o700 },
  );
  process.env.DEPLOY_CODEX_BIN = binary;
  const { modelOptions, validateRunSettings } = await import('./model-options.ts');
  let codex = modelOptions()[0];
  const deadline = Date.now() + 3000;
  while (!codex.models.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    codex = modelOptions()[0];
  }
  assert.deepEqual(
    codex.models.map((m) => m.id),
    ['available', 'other'],
  );
  assert.deepEqual(codex.models[0].efforts, ['high']);
  assert.throws(
    () => validateRunSettings({ model: 'available', effort: 'low' }, [codex]),
    /not supported/,
  );
});
