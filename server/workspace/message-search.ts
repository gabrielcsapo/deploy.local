import type Database from 'better-sqlite3';

/**
 * Text search over what people and agents said: task messages (`message`) and agent chats
 * (`agent-message`). A trigram index answers "contains these characters" for any text of three
 * or more characters, ignoring case, without scanning every message.
 *
 * A trigger's own `OR REPLACE` is overridden by the statement that fired it (an upsert aborts on
 * conflict), so the triggers delete the old entry and insert the new one.
 *
 * The index is keyed by the record's rowid and kept current by triggers, so every process that
 * writes a message keeps it in step. A search joins back to the record and checks the text
 * again, so a row the index has not caught up with can never show as a match.
 */
const TEXT = (row: string) => `CASE
  WHEN NOT json_valid(${row}.data) THEN ''
  WHEN ${row}.kind='message' THEN COALESCE(json_extract(${row}.data,'$.content'),'')
  ELSE COALESCE(json_extract(${row}.data,'$.event.text'),'') || ' ' || COALESCE(
    (SELECT group_concat(value, char(10)) FROM json_each(${row}.data,'$.event.paragraphs')),'')
END`;
const KINDS = `('message','agent-message')`;

export function ensureMessageSearch(db: Database.Database) {
  const existed = db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_search'").get();
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(content, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON records WHEN new.kind IN ${KINDS} BEGIN
  DELETE FROM message_search WHERE rowid=new.rowid;
  INSERT INTO message_search(rowid,content) VALUES(new.rowid, ${TEXT('new')});
END;
CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE ON records WHEN new.kind IN ${KINDS} BEGIN
  DELETE FROM message_search WHERE rowid=new.rowid;
  INSERT INTO message_search(rowid,content) VALUES(new.rowid, ${TEXT('new')});
END;
CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON records WHEN old.kind IN ${KINDS} BEGIN
  DELETE FROM message_search WHERE rowid=old.rowid;
END;`);
  if (!existed)
    db.exec(
      `INSERT OR REPLACE INTO message_search(rowid,content) SELECT rowid, ${TEXT('records')} FROM records WHERE kind IN ${KINDS}`,
    );
}

export const MESSAGE_SEARCH_MIN = 3;

export type MessageHit = { kind: 'message' | 'agent-message'; row: any; text: string };

/** The owner's messages containing `text`, newest first. Shorter than three characters finds nothing. */
export function searchMessageRecords(
  db: Database.Database,
  owner: string,
  text: string,
  limit = 200,
): MessageHit[] {
  if ([...text].length < MESSAGE_SEARCH_MIN) return [];
  const rows = db
    .prepare(
      `SELECT r.kind AS kind, r.data AS data, s.content AS content FROM message_search s
       JOIN records r ON r.rowid=s.rowid
       WHERE s.content MATCH ? AND r.kind IN ${KINDS} AND r.owner=?
       ORDER BY s.rowid DESC LIMIT ?`,
    )
    .all(`"${text.replaceAll('"', '""')}"`, owner, limit) as {
    kind: MessageHit['kind'];
    data: string;
    content: string;
  }[];
  const needle = text.toLowerCase();
  const hits: MessageHit[] = [];
  for (const { kind, data, content } of rows) {
    if (!content.toLowerCase().includes(needle)) continue;
    try {
      hits.push({ kind, row: JSON.parse(data), text: content });
    } catch {
      // A record that is not JSON has nothing to open.
    }
  }
  return hits;
}

/** One line of `text` around its first match, short enough for a result row. */
export function snippet(text: string, query: string, width = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  const cut = flat.slice(start, start + width);
  return (start > 0 ? '…' : '') + cut + (start + width < flat.length ? '…' : '');
}
