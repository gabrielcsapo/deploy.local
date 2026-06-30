/**
 * Buffered request-log writes (moved out of store.ts).
 *
 * Standalone so the edge process can use it without importing store.ts —
 * store runs drizzle migrations on open, and only the control plane may do
 * that. This module opens its own connections (worker thread preferred,
 * lazy in-process fallback) against the same WAL DB.
 *
 * The main thread accumulates entries in memory and ships them in bulk every
 * 2 seconds (or sooner at 500 entries) to the log-worker, which runs the
 * INSERT + rollup-upsert transaction off the event loop.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { buildRollups, ROLLUP_UPSERT_SQL } from './rollup.ts';

export interface RequestEntry {
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
  captureId?: string | null;
}

function resolveDbFile(): string {
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  return resolve(dataDir, 'deploy.db');
}

const REQUEST_LOG_BUFFER: Array<{ name: string; entry: RequestEntry }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 2000;
// 500 vs the old 100: under sustained load the smaller batch forced a flush
// every few hundred ms, which dominated SQLite write throughput. 500 still
// fits comfortably in one transaction; the 2s timer keeps low-traffic apps
// from waiting.
const FLUSH_BATCH_SIZE = 500;

export function logRequest(name: string, entry: RequestEntry) {
  REQUEST_LOG_BUFFER.push({ name, entry });
  if (REQUEST_LOG_BUFFER.length >= FLUSH_BATCH_SIZE) {
    flushRequestLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushRequestLogs, FLUSH_INTERVAL_MS);
  }
}

// ── Worker management ────────────────────────────────────────────────────────
// The worker (and the fallback connection) are pinned to the DB file they
// were created against. Tests swap DEPLOY_DATA_DIR between suites, so a
// change in the resolved path tears the old writer down and re-initializes.

let logWorker: Worker | null = null;
let logWorkerDisabled = false;
let activeDbFile: string | null = null;

function resetForDbChange(dbFile: string) {
  if (activeDbFile === dbFile) return;
  activeDbFile = dbFile;
  logWorkerDisabled = false;
  if (logWorker) {
    void logWorker.terminate();
    logWorker = null;
  }
  if (_fallbackDb) {
    try {
      _fallbackDb.close();
    } catch {
      /* ignore */
    }
    _fallbackDb = null;
    _fallbackTx = null;
  }
}

function getLogWorker(dbFile: string): Worker | null {
  if (logWorker) return logWorker;
  if (logWorkerDisabled) return null;
  try {
    // Production bundles ship a pre-built dist/log-worker.js next to the
    // entry; dev (tsx) loads the .ts source. The old code hardcoded the .ts
    // URL, which silently never resolved from inside the dist bundle — the
    // worker was disabled in production without anyone noticing.
    const jsUrl = new URL('./log-worker.js', import.meta.url);
    const workerUrl = existsSync(fileURLToPath(jsUrl))
      ? jsUrl
      : new URL('./log-worker.ts', import.meta.url);
    // Forward only module-loading flags (tsx/TS stripping) — without them,
    // .ts worker URLs fail to load under tsx. Forwarding ALL of execArgv
    // breaks spawn entirely: NODE_OPTIONS-derived flags like
    // --tls-cipher-list are rejected as invalid Worker execArgv.
    const tsFlags = process.execArgv.filter((a) =>
      /strip-types|transform-types|--loader|--import|--require|--experimental/.test(a),
    );
    logWorker = new Worker(workerUrl, {
      workerData: { dbFile },
      execArgv: tsFlags,
    });
    // The worker must not keep the process alive on its own — servers hold
    // their own handles, and test runners need to exit when suites finish.
    logWorker.unref();
    logWorker.on('error', (err) => {
      console.error('[request-log] worker errored, falling back to in-process flush:', err);
      logWorker = null;
      logWorkerDisabled = true;
    });
    logWorker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[request-log] worker exited with code ${code}`);
      }
      logWorker = null;
    });
    return logWorker;
  } catch (err) {
    console.warn(
      '[request-log] could not start worker, falling back to in-process flush:',
      (err as Error).message,
    );
    logWorkerDisabled = true;
    return null;
  }
}

// ── In-process fallback ──────────────────────────────────────────────────────

let _fallbackDb: InstanceType<typeof Database> | null = null;
let _fallbackTx: ((items: Array<{ name: string; entry: RequestEntry }>) => void) | null = null;

function ensureFallbackTx(dbFile: string) {
  if (_fallbackTx) return _fallbackTx;
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  _fallbackDb = sqlite;

  const insert = sqlite.prepare(
    `INSERT INTO request_logs (deployment_name, method, path, status, duration, timestamp, ip, user_agent, referrer, request_size, response_size, query_params, username, capture_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rollupUpsert = sqlite.prepare(ROLLUP_UPSERT_SQL);
  _fallbackTx = sqlite.transaction((items: Array<{ name: string; entry: RequestEntry }>) => {
    for (const { name, entry } of items) {
      insert.run(
        name,
        entry.method,
        entry.path,
        entry.status,
        entry.duration,
        entry.timestamp,
        entry.ip || null,
        entry.userAgent || null,
        entry.referrer || null,
        entry.requestSize || null,
        entry.responseSize || null,
        entry.queryParams || null,
        entry.username || null,
        entry.captureId || null,
      );
    }
    for (const r of buildRollups(items)) {
      rollupUpsert.run(
        r.deploymentName,
        r.bucketMs,
        r.count,
        r.errors4xx,
        r.errors5xx,
        r.durationSum,
        r.durationMin,
        r.durationMax,
      );
    }
  });
  return _fallbackTx;
}

export function flushRequestLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (REQUEST_LOG_BUFFER.length === 0) return;

  const dbFile = resolveDbFile();
  resetForDbChange(dbFile);

  const batch = REQUEST_LOG_BUFFER.splice(0);

  // Preferred path: ship the batch to the worker and return immediately.
  // The actual transaction runs off the main thread.
  const worker = getLogWorker(dbFile);
  if (worker) {
    try {
      worker.postMessage({ type: 'flush', items: batch });
      return;
    } catch (err) {
      // postMessage can throw if the worker terminated mid-send; fall through
      // to in-process flush so we don't drop the batch.
      console.warn('[request-log] worker postMessage failed, falling back:', err);
    }
  }

  // Fallback: run the transaction inline on this thread.
  try {
    ensureFallbackTx(dbFile)(batch);
  } catch (err) {
    // A single bad row used to abort the whole batch; rather than lose it,
    // log the failure but keep serving traffic. Losing some request_logs is
    // acceptable; pinning the event loop on a failing transaction is not.
    console.error('[request-log] flush failed:', err);
  }
}
