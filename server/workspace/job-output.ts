import type { Database } from '../sqlite.ts';

// Old releases can write inline output again. This normally empty index makes the
// startup repair proportional to those writes, without scanning all job history.
export const inlineJobOutput = "kind='job' AND json_type(data,'$.output') IS NOT NULL";

/** Called inside the workspace maintenance gate; all schema and data move atomically. */
export function migrateJobOutput(db: Database) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_output(
        owner TEXT, id TEXT, output TEXT, PRIMARY KEY(owner,id)
      );
      CREATE INDEX IF NOT EXISTS record_job_inline_output ON records(owner,id)
        WHERE ${inlineJobOutput};
      CREATE TRIGGER IF NOT EXISTS delete_job_output AFTER DELETE ON records
        WHEN OLD.kind='job'
        BEGIN
          DELETE FROM job_output WHERE owner=OLD.owner AND id=OLD.id;
        END;
    `);
    if (
      !db
        .prepare(
          `SELECT 1 FROM records INDEXED BY record_job_inline_output WHERE ${inlineJobOutput} LIMIT 1`,
        )
        .get()
    )
      return;
    db.exec(`
      INSERT INTO job_output(owner,id,output)
        SELECT owner,id,COALESCE(json_extract(data,'$.output'),'') FROM records INDEXED BY record_job_inline_output
        WHERE ${inlineJobOutput}
        ON CONFLICT(owner,id) DO UPDATE SET output=excluded.output;
      UPDATE records INDEXED BY record_job_inline_output SET data=json_remove(data,'$.output') WHERE ${inlineJobOutput};
    `);
  }).immediate();
}
