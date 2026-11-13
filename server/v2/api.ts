import { projectsApi } from './projects-api.ts';
import { performanceApi } from './performance.ts';
import { sendJson } from '../http.ts';
import { packagesApi } from '../packages/api.ts';
import { projectRemovalApi } from './project-removal.ts';
import { startApi } from './start.ts';
import { screenshotsApi } from './screenshots.ts';
import { pullFilesApi } from './pull-files.ts';
import { designApi } from './design.ts';
import { computersApi } from './computers.ts';
import { selfUpdateApi } from './self-update.ts';
import { diagnosticsApi } from './diagnostics.ts';
import { backupsApi } from './backups.ts';
import { authApi } from './auth.ts';
import { settingsApi } from './settings.ts';
import { agentsApi } from './agents.ts';
import { releasesApi } from './releases-api.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerInboxAsync, syncInbox } from './inbox.ts';
import { fail } from '../errors.ts';
import { tasksApi } from './tasks.ts';
import { liveApi } from './live.ts';
import { requestsApi } from './requests.ts';
import { pushApi } from './push.ts';
import { waitForV2Events } from './events.ts';
import { db, cursor as latestCursor } from '../workspace/store.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;

export async function v2Api(req: IncomingMessage, res: ServerResponse, requireAuth: RequireAuth) {
  const send = (value: unknown, status = 200) => {
    sendJson(res, value, status, { guard: true });
  };
  try {
    if (await screenshotsApi(req, res, requireAuth)) return;
    if (await authApi(req, res, requireAuth)) return;
    if (await pushApi(req, res, requireAuth)) return;
    if (await liveApi(req, res, requireAuth)) return;
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      return send({ error: 'Agent and worker credentials cannot access client commands' }, 403);
    if (await packagesApi(req, res, auth.username)) return;
    if (await designApi(req, res, auth.username)) return;
    if (await startApi(req, res, auth.username)) return;
    if (await projectRemovalApi(req, res, auth.username)) return;
    if (await tasksApi(req, res, auth.username)) return;
    if (await pullFilesApi(req, res, auth.username)) return;
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname.slice('/api/v2'.length);
    if (await computersApi(req, res, auth.username)) return;
    if (await selfUpdateApi(req, res, auth.username)) return;
    if (await diagnosticsApi(req, res, auth.username)) return;
    if (await backupsApi(req, res, auth.username)) return;
    if (await projectsApi(req, res, auth.username)) return;
    if (await settingsApi(req, res, auth.username)) return;
    if (await agentsApi(req, res, auth.username)) return;
    if (await releasesApi(req, res, auth.username)) return;
    if (await requestsApi(req, res, auth.username)) return;
    if (await performanceApi(req, res, auth.username)) return;
    if (req.method === 'GET' && path === '/inbox') {
      const state = url.searchParams.get('state') ?? 'waiting';
      if (!['waiting', 'answered'].includes(state)) fail('State must be waiting or answered');
      // Pair each list with the exact event position of its SQLite snapshot. The two
      // lists may be read at different times; clients retain both boundaries.
      return send(
        db
          .transaction(() => ({
            items: syncInbox(auth.username).filter((item) => item.state === state),
            cursor: latestCursor(auth.username),
          }))
          .immediate(),
      );
    }
    if (req.method === 'GET' && path === '/events') {
      // A client that has just loaded a snapshot starts at the newest event instead of replaying history.
      if (url.searchParams.get('after') === 'latest')
        return send({ events: [], cursor: latestCursor(auth.username), supportsWait: true });
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
      return send({
        item: await answerInboxAsync(auth.username, decodeURIComponent(answer[1]), body),
      });
    }
    return send({ error: 'Not found' }, 404);
  } catch (error: any) {
    return send(
      {
        error: error.message,
        ...(error.dataLoss ? { dataLoss: error.dataLoss } : {}),
        ...(error.answer !== undefined ? { answer: error.answer, item: error.item } : {}),
      },
      error.status || 400,
    );
  }
}
