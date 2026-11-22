import type { IncomingMessage } from 'node:http';
export async function readTelemetryBytes(req: IncomingMessage, cap: number) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > cap)) {
    req.resume();
    throw Object.assign(new Error('Telemetry body too large'), { status: 413 });
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > cap) {
      req.resume();
      throw Object.assign(new Error('Telemetry body too large'), { status: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}

/** Bounded peer-IP fixed windows. Forwarded headers are never trusted for ingestion. */
export class TelemetryRateLimit {
  private peers = new Map<string, { at: number; count: number }>();
  private limit: number;
  private capacity: number;
  constructor(limit = 120, capacity = 10_000) {
    this.limit = limit;
    this.capacity = capacity;
  }
  allow(ip: string, now = Date.now()) {
    let peer = this.peers.get(ip);
    if (peer && now - peer.at >= 60_000) {
      this.peers.delete(ip);
      peer = undefined;
    }
    if (!peer) {
      if (this.peers.size >= this.capacity) {
        for (const [key, value] of this.peers) if (now - value.at >= 60_000) this.peers.delete(key);
        if (this.peers.size >= this.capacity) return false;
      }
      this.peers.set(ip, (peer = { at: now, count: 0 }));
    }
    return ++peer.count <= this.limit;
  }
}
export async function readTelemetryBody(req: IncomingMessage, cap: number) {
  const data = await readTelemetryBytes(req, cap);
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid telemetry JSON'), { status: 400 });
  }
}
