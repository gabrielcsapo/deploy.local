import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('a trace audit requires the sampled action, milestone, connected services and attempted trial count', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-audit-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const file = join(dir, 'trial.json');
  const row = {
    attributes: {},
    status: 0,
    startTimeUnixNano: '1000000',
    endTimeUnixNano: '4000000',
    events: [],
  };
  const root = {
    ...row,
    spanId: 'root',
    service: 'phone',
    name: 'open',
    events: [{ name: 'ready', timeUnixNano: '4000000' }],
  };
  const child = {
    ...row,
    spanId: 'server',
    parentSpanId: 'root',
    service: 'server',
    name: 'request',
  };
  function audit(spans, args = []) {
    writeFileSync(file, JSON.stringify({ spans, truncated: false }));
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./audit-trace.ts', import.meta.url)),
        '--service',
        'phone',
        '--root',
        'open',
        '--event',
        'ready',
        '--require-service',
        'server',
        ...args,
        file,
      ],
      { encoding: 'utf8' },
    );
    return {
      status: result.status,
      rows: result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    };
  }
  const ok = audit([root, child]);
  assert.equal(ok.status, 0);
  assert.equal(ok.rows[1].medianMs, 3);
  assert.equal(audit([root, child], ['--expected-trials', '2']).status, 1);
  assert.equal(audit([root]).status, 1);
  assert.equal(audit([{ ...root, events: [] }, child]).status, 1);
  assert.equal(audit([root, { ...child, parentSpanId: 'absent' }]).status, 1);
  assert.equal(audit([root, { ...child, parentSpanId: 'server' }]).status, 1);
});
