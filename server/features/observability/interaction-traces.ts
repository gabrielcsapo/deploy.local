import type { Database } from '../../kernel/db/sqlite.ts';
import type { InteractionEvent } from '../../../packages/trace/interaction.js';
const label = /^[a-z][a-z0-9_.-]{0,47}$/;
const traceId = /^(?!0{32}$)[a-f0-9]{32}$/;
const spanId = /^(?!0{16}$)[a-f0-9]{16}$/;
function text(v: unknown, re: RegExp) {
  return typeof v === 'string' && re.test(v);
}
function time(v: unknown) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 86400000;
}
function invalid(): never {
  throw Object.assign(new Error('Invalid interaction'), { status: 400 });
}
export function validateInteraction(value: unknown) {
  const e = value as InteractionEvent;
  if (
    !e ||
    !text(e.traceId, traceId) ||
    !text(e.spanId, spanId) ||
    !text(e.name, label) ||
    !text(e.milestone, label) ||
    !['ok', 'error', 'cancelled'].includes(e.outcome) ||
    !['web', 'apple'].includes(e.platform) ||
    !time(e.durationMs) ||
    (e.startedAtUnixMs !== undefined &&
      (!Number.isFinite(e.startedAtUnixMs) || e.startedAtUnixMs <= 0)) ||
    !Array.isArray(e.spans) ||
    e.spans.length > 16
  )
    invalid();
  for (const s of e.spans)
    if (
      !s ||
      !text(s.spanId, spanId) ||
      !text(s.parentSpanId, spanId) ||
      s.spanId === s.parentSpanId ||
      s.spanId === e.spanId ||
      !text(s.name, label) ||
      !time(s.startMs) ||
      !time(s.durationMs) ||
      (s.failed !== undefined && typeof s.failed !== 'boolean')
    )
      invalid();
  return e;
}
export function storeInteraction(db: Database, project: string, value: unknown, now = Date.now()) {
  const e = validateInteraction(value);
  db.transaction(() => {
    const existing = db
      .prepare('SELECT span_id FROM interaction_roots WHERE project=? AND trace_id=?')
      .get(project, e.traceId) as { span_id: string } | undefined;
    if (existing && existing.span_id !== e.spanId) invalid();
    if (!existing) {
      const minute = Math.floor(now / 60000) * 60000;
      db.prepare('INSERT OR IGNORE INTO interaction_volume(project,minute) VALUES(?,?)').run(
        project,
        minute,
      );
      const volume = db
        .prepare('SELECT priority,healthy FROM interaction_volume WHERE project=? AND minute=?')
        .get(project, minute) as { priority: number; healthy: number };
      const priority = e.outcome !== 'ok' || e.durationMs >= 1000;
      // A burst of healthy opens cannot spend the slots reserved for failures and slow opens.
      const retain = priority
        ? volume.priority < 60
        : volume.healthy < 20 ||
          (volume.healthy < 60 && parseInt(e.traceId.slice(-2), 16) % 16 === 0);
      const counter = retain ? (priority ? 'priority' : 'healthy') : 'dropped';
      db.prepare(
        `UPDATE interaction_volume SET ${counter}=${counter}+1 WHERE project=? AND minute=?`,
      ).run(project, minute);
      if (!retain) return;
    }
    db.prepare(
      'INSERT OR IGNORE INTO interaction_roots (project,trace_id,span_id,name,milestone,outcome,platform,duration_ms,at,start_unix_ms) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      project,
      e.traceId,
      e.spanId,
      e.name,
      e.milestone,
      e.outcome,
      e.platform,
      e.durationMs,
      now,
      e.startedAtUnixMs ?? null,
    );
    const insert = db.prepare(
      'INSERT OR IGNORE INTO interaction_spans SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM interaction_spans WHERE project=? AND trace_id=?)<16',
    );
    for (const s of e.spans)
      insert.run(
        project,
        e.traceId,
        s.spanId,
        s.parentSpanId,
        s.name,
        s.startMs,
        s.durationMs,
        s.failed ? 1 : 0,
        project,
        e.traceId,
      );
  })();
}
export function readInteraction(db: Database, project: string, id: string) {
  const root = db
    .prepare(
      'SELECT span_id AS spanId,name,milestone,outcome,platform,duration_ms AS durationMs,start_unix_ms AS startedAtUnixMs FROM interaction_roots WHERE project=? AND trace_id=?',
    )
    .get(project, id) as Omit<InteractionEvent, 'traceId' | 'spans'> | undefined;
  return (
    root && {
      ...root,
      spans: db
        .prepare(
          'SELECT span_id AS spanId,parent_id AS parentSpanId,name,start_ms AS startMs,duration_ms AS durationMs,failed FROM interaction_spans WHERE project=? AND trace_id=? ORDER BY start_ms',
        )
        .all(project, id),
    }
  );
}
