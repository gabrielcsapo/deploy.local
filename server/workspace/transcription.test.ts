import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { transcribe } from './transcription.ts';

test('dictation bounds input, forwards the configured model, rejects redirects, and limits concurrent requests', async () => {
  const keys = [
    'DEPLOY_TRANSCRIPTION_BASE_URL',
    'DEPLOY_TRANSCRIPTION_MODEL',
    'DEPLOY_TRANSCRIPTION_API_KEY',
  ];
  const before = keys.map((k) => process.env[k]);
  let calls = 0;
  let mode = 'ok';
  let unblock: (() => void) | undefined;
  const provider = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(chunk);
    const form = await new Response(Buffer.concat(body), {
      headers: { 'content-type': String(req.headers['content-type']) },
    }).formData();
    assert.equal(form.get('model'), 'fixture-whisper');
    assert.equal(await (form.get('file') as File).text(), 'fixture audio');
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    if (mode === 'redirect') {
      res.writeHead(307, { Location: '/unexpected' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '  Review this draft.  ' }));
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const api = createServer((req, res) => void transcribe(req, res, 'fixture-owner')).listen(
    0,
    '127.0.0.1',
  );
  await once(api, 'listening');
  const url = `http://127.0.0.1:${(api.address() as any).port}`;
  const send = (type = 'audio/webm', body = 'fixture audio') =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });
  try {
    delete process.env.DEPLOY_TRANSCRIPTION_MODEL;
    assert.equal((await send()).status, 503);
    process.env.DEPLOY_TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${(provider.address() as any).port}/v1`;
    process.env.DEPLOY_TRANSCRIPTION_MODEL = 'fixture-whisper';
    process.env.DEPLOY_TRANSCRIPTION_API_KEY = 'fixture-token';
    assert.equal((await send('text/plain')).status, 415);
    assert.equal((await send('audio/webm', '')).status, 400);
    assert.equal((await send('audio/webm', 'x'.repeat(12 * 1024 * 1024 + 1))).status, 413);
    assert.equal(calls, 0);
    assert.deepEqual(await (await send()).json(), { text: 'Review this draft.' });
    mode = 'hold';
    const pending = send();
    while (!unblock) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await send()).status, 429);
    unblock();
    assert.equal((await pending).status, 200);
    mode = 'redirect';
    const redirected = await send();
    assert.equal(redirected.status, 502);
    assert.equal(calls, 3); // No request followed the redirect.
  } finally {
    unblock?.();
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
    api.closeAllConnections();
    provider.closeAllConnections();
    api.close();
    provider.close();
  }
});
