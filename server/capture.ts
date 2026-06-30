/**
 * 5xx request/response captures.
 *
 * When a proxied request fails (the app returned 5xx, or the edge generated
 * a 502), the hot path snapshots the request headers, up to 16 KiB of the
 * request body, and up to 64 KiB of the response body into a JSON file under
 * `.deploy-data/captures/<app>/<id>.json`. The request_logs row carries the
 * capture id so the dashboard can show exactly what the failing response was.
 *
 * Costs stay off the happy path: GET/HEAD/OPTIONS requests get no body tap
 * at all, other bodies are buffered only up to the cap while streaming to
 * the app, and header/body serialization happens only once a 5xx is seen.
 * Written by whichever process runs the hot path (edge, or single-process
 * mode); read by the control plane for the dashboard.
 */

import { mkdirSync } from 'node:fs';
import { writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

export const REQUEST_BODY_CAP = 16 * 1024;
export const RESPONSE_BODY_CAP = 64 * 1024;

// Disk-churn guard for 5xx storms: at most this many captures per app per
// minute. Further failures still get a request_logs row, just no body file.
const MAX_CAPTURES_PER_MIN = 30;

function captureRoot(): string {
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  return resolve(dataDir, 'captures');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Body taps ────────────────────────────────────────────────────────────────
// A tap rides alongside the existing pipe() consumer — it never pauses or
// redirects the stream, it just copies chunks until the cap is reached and
// keeps counting bytes after that.

export interface BodyTap {
  chunks: Buffer[];
  buffered: number;
  total: number;
  truncated: boolean;
}

export function createBodyTap(stream: Readable, cap: number): BodyTap {
  const tap: BodyTap = { chunks: [], buffered: 0, total: 0, truncated: false };
  stream.on('data', (chunk: Buffer) => {
    tap.total += chunk.length;
    if (tap.buffered >= cap) {
      tap.truncated = true;
      return;
    }
    const room = cap - tap.buffered;
    if (chunk.length <= room) {
      tap.chunks.push(chunk);
      tap.buffered += chunk.length;
    } else {
      tap.chunks.push(chunk.subarray(0, room));
      tap.buffered = cap;
      tap.truncated = true;
    }
  });
  return tap;
}

const kReqTap = Symbol('deployRequestBodyTap');

/**
 * Speculatively tap the request body (it streams to the app before we know
 * the response status). Bodyless methods skip the tap entirely; retries of
 * the same request reuse the existing tap instead of double-attaching.
 */
export function tapRequestBody(req: IncomingMessage, method: string): BodyTap | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const carrier = req as IncomingMessage & { [kReqTap]?: BodyTap };
  if (carrier[kReqTap]) return carrier[kReqTap];
  const tap = createBodyTap(req, REQUEST_BODY_CAP);
  carrier[kReqTap] = tap;
  return tap;
}

interface DecodedBody {
  body: string | null;
  bodyBytes: number;
  bodyTruncated: boolean;
}

export function decodeBody(tap: BodyTap | null, contentType: string | undefined): DecodedBody {
  if (!tap || tap.total === 0) {
    return { body: null, bodyBytes: tap?.total ?? 0, bodyTruncated: false };
  }
  const ct = contentType || '';
  const binary = /image\/|audio\/|video\/|font\/|octet-stream|protobuf|\bzip\b|gzip/.test(ct);
  return {
    body: binary
      ? `[${tap.total} bytes of ${ct || 'binary'} omitted]`
      : Buffer.concat(tap.chunks).toString('utf8'),
    bodyBytes: tap.total,
    bodyTruncated: tap.truncated,
  };
}

// ── Capture records ──────────────────────────────────────────────────────────

export interface CaptureRecord {
  id: string;
  deploymentName: string;
  timestamp: number;
  method: string;
  path: string;
  query: string | null;
  status: number;
  durationMs: number;
  /** Set when the edge generated the failure (502): timeout | refused | error. */
  failureReason?: string;
  request: {
    headers: Record<string, string | string[] | undefined>;
    body: string | null;
    bodyBytes: number;
    bodyTruncated: boolean;
  };
  /** Null when the app never responded (edge-generated 502). */
  response: {
    headers: Record<string, string | string[] | undefined>;
    body: string | null;
    bodyBytes: number;
    bodyTruncated: boolean;
  } | null;
}

const rateState = new Map<string, { windowStart: number; count: number }>();

/**
 * Reserve a capture id, or null when the per-app rate limit is exhausted.
 * Cheap enough for the hot path — a Map lookup and (on 5xx only) 4 random
 * bytes.
 */
export function beginCapture(deploymentName: string): string | null {
  const now = Date.now();
  let s = rateState.get(deploymentName);
  if (!s || now - s.windowStart > 60_000) {
    s = { windowStart: now, count: 0 };
    rateState.set(deploymentName, s);
  }
  if (s.count >= MAX_CAPTURES_PER_MIN) return null;
  s.count++;
  return `${now.toString(36)}-${randomBytes(4).toString('hex')}`;
}

const ensuredDirs = new Set<string>();

/** Fire-and-forget write — capture loss is acceptable, blocking the proxy is not. */
export function writeCapture(record: CaptureRecord): void {
  try {
    const dir = join(captureRoot(), sanitizeName(record.deploymentName));
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
    }
    void writeFile(join(dir, `${record.id}.json`), JSON.stringify(record)).catch((err) => {
      console.error('[capture] write failed:', err);
    });
  } catch (err) {
    console.error('[capture] write failed:', err);
  }
}

const SAFE_ID = /^[a-z0-9-]{1,64}$/;

export async function readCapture(
  deploymentName: string,
  id: string,
): Promise<CaptureRecord | null> {
  if (!SAFE_ID.test(id)) return null;
  const file = join(captureRoot(), sanitizeName(deploymentName), `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CaptureRecord;
  } catch {
    return null;
  }
}

/** Delete capture files older than maxAgeMs. Returns how many were removed. */
export async function pruneOldCaptures(maxAgeMs: number): Promise<number> {
  const root = captureRoot();
  let appDirs: string[];
  try {
    appDirs = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const app of appDirs) {
    const dir = join(root, app);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const st = await stat(join(dir, f));
        if (st.mtimeMs < cutoff) {
          await rm(join(dir, f));
          removed++;
        }
      } catch {
        // raced with another pruner or write — fine
      }
    }
  }
  return removed;
}
