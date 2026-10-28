import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerInbox, fail, syncInbox } from './inbox.ts';
import { waitForV2Events } from './events.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;

export async function v2Api(req: IncomingMessage, res: ServerResponse, requireAuth: RequireAuth) {
  const send = (value: unknown, status = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      return send({ error: 'Agent and worker credentials cannot access client commands' }, 403);
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname.slice('/api/v2'.length);
    if (req.method === 'GET' && path === '/inbox') {
      const state = url.searchParams.get('state') ?? 'waiting';
      if (!['waiting', 'answered'].includes(state)) fail('State must be waiting or answered');
      return send({ items: syncInbox(auth.username).filter((item) => item.state === state) });
    }
    if (req.method === 'GET' && path === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const waitMs = Number(url.searchParams.get('waitMs') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0)
        fail('after and waitMs must be non-negative safe integers');
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      try {
        return send(await waitForV2Events(auth.username, after, waitMs, controller.signal));
      } finally {
        res.off('close', abort);
      }
    }
    const answer = path.match(/^\/inbox\/([^/]+)\/answer$/);
    if (req.method === 'POST' && answer) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 32_768) {
          req.resume();
          fail('Answer body too large', 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        fail('Invalid JSON');
      }
      return send({ item: answerInbox(auth.username, decodeURIComponent(answer[1]), body) });
    }
    return send({ error: 'Not found' }, 404);
  } catch (error: any) {
    return send(
      {
        error: error.message,
        ...(error.answer !== undefined ? { answer: error.answer, item: error.item } : {}),
      },
      error.status || 400,
    );
  }
}
