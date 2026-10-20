import { openSync, closeSync, readSync, fstatSync } from 'node:fs';

export function videoLimit() {
  const value = Number(process.env.DEPLOY_VIDEO_LIMIT_BYTES || 200 * 1024 * 1024);
  return Number.isSafeInteger(value) && value > 0 ? value : 200 * 1024 * 1024;
}
export function sniffVideo(data: Buffer) {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return { mimeType: 'video/webm' };
  if (data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp' && data.readUInt32BE(0) >= 16)
    return { mimeType: data.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  return null;
}
/** Walk box headers, skipping media payloads. Read at most 64 bytes per box and 4096 boxes. */
export function mp4Duration(path: string | Buffer): number | null {
  const fd = typeof path === 'string' ? openSync(path, 'r') : null;
  const length = fd === null ? (path as Buffer).length : fstatSync(fd).size;
  try {
    let budget = 4096;
    const visit = (start: number, end: number, depth = 0): number | null => {
      if (depth > 2) return null;
      for (let at = start; at + 8 <= end && budget-- > 0;) {
        const bytes = Buffer.alloc(64);
        const count =
          fd === null
            ? (path as Buffer).copy(bytes, 0, at, Math.min(at + 64, end))
            : readSync(fd, bytes, 0, Math.min(64, end - at), at);
        let size = bytes.readUInt32BE(0),
          header = 8;
        if (size === 1) {
          if (count < 16) return null;
          size = Number(bytes.readBigUInt64BE(8));
          header = 16;
        }
        if (size === 0) size = end - at;
        if (!Number.isSafeInteger(size) || size < header || at + size > end) return null;
        const type = bytes.toString('ascii', 4, 8);
        if (type === 'moov') {
          const duration = visit(at + header, at + size, depth + 1);
          if (duration !== null) return duration;
        }
        if (type === 'mvhd') {
          const version = bytes[header];
          const offset = header + (version === 1 ? 20 : 12);
          if (
            (version !== 0 && version !== 1) ||
            count < offset + (version === 1 ? 12 : 8) ||
            size < offset + (version === 1 ? 12 : 8)
          )
            return null;
          const scale = bytes.readUInt32BE(offset);
          const ticks =
            version === 1
              ? Number(bytes.readBigUInt64BE(offset + 4))
              : bytes.readUInt32BE(offset + 4);
          if (!scale || (version === 0 && ticks === 0xffffffff) || !Number.isSafeInteger(ticks))
            return null;
          return ticks / scale;
        }
        at += size;
      }
      return null;
    };
    return visit(0, length);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
export function videoInputNote(row: { name: string; duration?: number | null }) {
  const duration = row.duration == null ? 'duration unknown' : `${Math.round(row.duration)} s`;
  return `The user attached a video, ${row.name}, ${duration}; you cannot view video directly.`;
}
