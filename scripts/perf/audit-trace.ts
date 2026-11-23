import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { timeline, type TraceDetail } from '../../app/routes/dashboard/v2/projects/trace-model.ts';

const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    service: { type: 'string' },
    root: { type: 'string' },
    event: { type: 'string' },
    'expected-trials': { type: 'string' },
    'require-service': { type: 'string', multiple: true },
  },
});
const expected =
  values['expected-trials'] === undefined ? files.length : Number(values['expected-trials']);
if (
  !Number.isSafeInteger(expected) ||
  expected < 1 ||
  !values.service ||
  !values.root ||
  !values.event
) {
  console.error(
    'Usage: node scripts/perf/audit-trace.ts --service NAME --root OPERATION --event MILESTONE [--expected-trials N] [--require-service NAME] trace.json ...',
  );
  process.exit(2);
}

const durations: number[] = [];
const seen = new Set<string>();
for (const file of files) {
  const issues: string[] = [];
  let durationMs: number | undefined;
  try {
    const detail: TraceDetail & { traceId?: string } = JSON.parse(readFileSync(file, 'utf8'));
    const model = timeline(detail);
    if (detail.truncated) issues.push('truncated export');
    if (model.all.some((row) => row.parent && !model.byId.has(row.parent)))
      issues.push('missing parent');
    const roots = model.all.filter((row) => !row.parent);
    const root = roots.find((row) => row.name === values.root && row.service === values.service);
    if (roots.length !== 1 || !root) issues.push('expected a single matching root');
    if (root) {
      const reachable = new Set<string>();
      const pending = [root];
      while (pending.length) {
        const row = pending.pop()!;
        if (reachable.has(row.id)) continue;
        reachable.add(row.id);
        for (const child of model.children.get(row.id) ?? []) pending.push(child);
      }
      if (reachable.size !== model.byId.size) issues.push('disconnected spans');
      if (
        !root.events.some((e) => e.name === values.event && e.at >= root.start && e.at <= root.end)
      )
        issues.push('missing milestone in root interval');
      if (root.status === 'Error') issues.push('root failed');
      const key = detail.traceId ?? root.id;
      if (seen.has(key)) issues.push('duplicate sample');
      seen.add(key);
      durationMs = root.end - root.start;
    }
    if (
      model.all.some(
        (row) => !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end < row.start,
      )
    )
      issues.push('invalid interval');
    for (const service of values['require-service'] ?? []) {
      if (!model.all.some((row) => row.service === service))
        issues.push('missing service: ' + service);
    }
  } catch {
    issues.push('unreadable trace detail');
  }
  console.log(JSON.stringify({ file, durationMs, issues }));
  if (issues.length) process.exitCode = 1;
  else if (durationMs !== undefined) durations.push(durationMs);
}
durations.sort((a, b) => a - b);
const n = durations.length;
if (files.length !== expected) process.exitCode = 1;
console.log(
  JSON.stringify({
    expected,
    received: files.length,
    passed: n,
    medianMs: n ? (durations[Math.floor((n - 1) / 2)] + durations[Math.floor(n / 2)]) / 2 : null,
  }),
);
