/**
 * Background worker for batched request_logs INSERTs.
 *
 * The main thread accumulates log entries into an in-memory buffer (cheap)
 * and ships them here in bulk every 2 seconds (or sooner at 500 entries).
 * This worker:
 *   1. Opens its own better-sqlite3 connection to the same WAL-mode DB —
 *      SQLite's WAL lets multiple writers from different processes/threads
 *      coexist safely.
 *   2. Runs the INSERT as a single prepared transaction.
 *
 * Why a worker: at high RPS the 5–20ms transaction cost was running on the
 * main thread between proxy ticks. Moving it here means the proxy event
 * loop is never blocked by request-log flushes.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

interface RequestEntry {
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  requestSize?: number | null;
  responseSize?: number | null;
  queryParams?: string | null;
  username?: string | null;
}

interface FlushMessage {
  type: 'flush';
  items: Array<{ name: string; entry: RequestEntry }>;
}

const { dbFile } = workerData as { dbFile: string };

const sqlite = new Database(dbFile);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');

const insert = sqlite.prepare<
  [
    string,
    string,
    string,
    number,
    number,
    number,
    string | null,
    string | null,
    string | null,
    number | null,
    number | null,
    string | null,
    string | null,
  ]
>(
  `INSERT INTO request_logs (deployment_name, method, path, status, duration, timestamp, ip, user_agent, referrer, request_size, response_size, query_params, username)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const flushTx = sqlite.transaction((items: Array<{ name: string; entry: RequestEntry }>) => {
  for (const { name, entry } of items) {
    insert.run(
      name,
      entry.method,
      entry.path,
      entry.status,
      entry.duration,
      entry.timestamp,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.referrer ?? null,
      entry.requestSize ?? null,
      entry.responseSize ?? null,
      entry.queryParams ?? null,
      entry.username ?? null,
    );
  }
});

parentPort?.on('message', (msg: FlushMessage) => {
  if (msg.type !== 'flush' || !msg.items || msg.items.length === 0) return;
  try {
    flushTx(msg.items);
  } catch (err) {
    // Drop bad batches loudly; never let one corrupt entry stop subsequent
    // flushes. The main thread has already moved on.
    // eslint-disable-next-line no-console
    console.error('[log-worker] flush failed:', err);
  }
});

parentPort?.on('close', () => {
  try {
    sqlite.close();
  } catch {
    // ignore
  }
});
