import type { Database } from '../../kernel/db/sqlite.ts';
export function readOtlp(db: Database, project: string, id: string) {
  const rows = db
    .prepare('SELECT span FROM otlp_spans WHERE project=? AND trace_id=? LIMIT 1001')
    .all(project, id) as { span: string }[];
  return {
    spans: rows.slice(0, 1000).map((r) => JSON.parse(r.span)),
    truncated: rows.length > 1000,
  };
}
