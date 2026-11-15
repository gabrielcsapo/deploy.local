import { sendJson } from '../../kernel/http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
const limit = 12 * 1024 * 1024;
const active = new Set<string>();
const formats: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
};
export function transcriptionAvailable() {
  return Boolean(
    process.env.DEPLOY_TRANSCRIPTION_BASE_URL && process.env.DEPLOY_TRANSCRIPTION_MODEL,
  );
}
export async function transcribe(req: IncomingMessage, res: ServerResponse, owner: string) {
  const send = (status: number, value: unknown) => {
    sendJson(res, value, status);
  };
  if (!transcriptionAvailable())
    return send(503, { error: 'Voice input is not configured on this coordinator.' });
  if (active.has(owner) || active.size >= 4)
    return send(429, { error: 'A transcription is already in progress. Try again shortly.' });
  const mime = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim();
  if (!formats[mime]) return send(415, { error: 'Unsupported audio format.' });
  if (Number(req.headers['content-length']) > limit)
    return send(413, { error: 'Recording exceeds 12 MB.' });
  active.add(owner);
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', disconnected);
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        send(413, { error: 'Recording exceeds 12 MB.' });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    if (!size) return send(400, { error: 'Recording is empty.' });
    const form = new FormData();
    form.set('model', process.env.DEPLOY_TRANSCRIPTION_MODEL!);
    form.set(
      'file',
      new Blob([new Uint8Array(Buffer.concat(chunks))], { type: mime }),
      `dictation.${formats[mime]}`,
    );
    const response = await fetch(
      process.env.DEPLOY_TRANSCRIPTION_BASE_URL!.replace(/\/$/, '') + '/audio/transcriptions',
      {
        method: 'POST',
        body: form,
        redirect: 'error',
        headers: process.env.DEPLOY_TRANSCRIPTION_API_KEY
          ? { Authorization: `Bearer ${process.env.DEPLOY_TRANSCRIPTION_API_KEY}` }
          : {},
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
      },
    );
    if (!response.ok)
      return send(502, {
        error: `Voice provider returned HTTP ${response.status}. Please try again.`,
      });
    const result = await response.json();
    if (typeof result.text !== 'string' || result.text.length > 100000)
      return send(502, { error: 'Voice provider returned an invalid transcript.' });
    send(200, { text: result.text.trim() });
  } catch {
    if (!res.destroyed && !res.headersSent)
      send(502, { error: 'Transcription could not finish. Please try again.' });
  } finally {
    active.delete(owner);
    res.off('close', disconnected);
  }
}
