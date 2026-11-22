import { startHttpSpan, httpBatch } from '../../packages/trace/http.js';
import { storeOtlp } from '../otlp.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { dispatch, routes } from '../kernel/routes.ts';
import { projectsApi } from './projects-api.ts';
import { performanceApi } from './performance.ts';
import { sendJson } from '../kernel/http.ts';
import { packagesApi } from '../packages/api.ts';
import { projectRemovalApi } from './project-removal.ts';
import { startApi } from './start.ts';
import { screenshotsApi } from './screenshots.ts';
import { pullFilesApi } from './pull-files.ts';
import { designApi } from './design.ts';
import { artifactsApi } from './artifacts.ts';
import { searchApi } from './search.ts';
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
import { fail } from '../kernel/errors.ts';
import { tasksApi } from './tasks.ts';
import { liveApi } from './live.ts';
import { requestsApi } from './requests.ts';
import { pushApi } from './push.ts';
import { waitForV2Events } from './events.ts';
import { db, cursor as latestCursor } from '../workspace/store.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;
type FeatureApi<A> = (req: IncomingMessage, res: ServerResponse, auth: A) => Promise<boolean>;

// Dispatch order: the first feature that answers wins. These check credentials themselves.
const beforeSignIn: FeatureApi<RequireAuth>[] = [screenshotsApi, authApi, pushApi, liveApi];
// These run for a signed-in person, never for agent or worker credentials.
const signedIn: FeatureApi<string>[] = [
  packagesApi,
  designApi,
  artifactsApi,
  searchApi,
  startApi,
  projectRemovalApi,
  tasksApi,
  pullFilesApi,
  computersApi,
  selfUpdateApi,
  diagnosticsApi,
  backupsApi,
  projectsApi,
  settingsApi,
  agentsApi,
  releasesApi,
  requestsApi,
  performanceApi,
];

const featureApis: Record<string, FeatureApi<RequireAuth> | FeatureApi<string>> = {
  'v2/screenshots': screenshotsApi,
  'v2/attachments': screenshotsApi,
  'v2/auth': authApi,
  'v2/push': pushApi,
  'v2/live': liveApi,
  'packages/api': packagesApi,
  'v2/design': designApi,
  'v2/artifacts': artifactsApi,
  'v2/search': searchApi,
  'v2/start': startApi,
  'v2/project-removal': projectRemovalApi,
  'v2/tasks': tasksApi,
  'v2/pull-files': pullFilesApi,
  'v2/computers': computersApi,
  'v2/self-update': selfUpdateApi,
  'v2/diagnostics': diagnosticsApi,
  'v2/backups': backupsApi,
  'v2/projects-api': projectsApi,
  'v2/settings': settingsApi,
  'v2/logs': settingsApi,
  'v2/agents': agentsApi,
  'v2/releases-api': releasesApi,
  'v2/requests': requestsApi,
  'v2/performance': performanceApi,
};

const observedResponses = new WeakSet<ServerResponse>();
export async function v2Api(
  req: IncomingMessage,
  res: ServerResponse,
  requireAuth: RequireAuth,
  feature?: string,
  template?: string,
) {
  const send = (value: unknown, status = 200) => {
    sendJson(res, value, status, { guard: true });
  };
  try {
    const authenticate: RequireAuth = (req, res) => {
      const auth = requireAuth(req, res);
      if (
        auth &&
        !req.headers['x-deploy-agent-token'] &&
        !req.headers['x-deploy-worker-token'] &&
        !observedResponses.has(res) &&
        !req.url?.startsWith('/api/control/') &&
        !req.url?.startsWith('/api/activity-events')
      ) {
        const finish = startHttpSpan(req.headers.traceparent);
        if (finish) {
          observedResponses.add(res);
          const route = template ?? '/api/*';
          res.once('finish', () => {
            const span = finish(req.method ?? 'GET', route, res.statusCode);
            setImmediate(() => {
              try {
                storeOtlp(
                  getRequestsSqlite(),
                  'control:' + auth.username,
                  httpBatch('deploy.server', [span]),
                );
              } catch {}
            });
          });
        }
      }
      return auth;
    };
    for (const api of beforeSignIn)
      if ((!feature || featureApis[feature] === api) && (await api(req, res, authenticate))) return;
    const auth = authenticate(req, res);
    if (!auth) return;
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      return send({ error: 'Agent and worker credentials cannot access client commands' }, 403);
    for (const api of signedIn)
      if ((!feature || featureApis[feature] === api) && (await api(req, res, auth.username)))
        return;
    const route = routes<undefined>();
    if (
      await dispatch(
        [
          route({
            method: 'GET',
            path: '/inbox',
            handler: ({ url }) => {
              const state = url.searchParams.get('state') ?? 'waiting';
              if (!['waiting', 'answered'].includes(state))
                fail('State must be waiting or answered');
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
            },
          }),
          route({
            method: 'GET',
            path: '/activity-events',
            handler: async ({ url }) => {
              // A client that has just loaded a snapshot starts at the newest event instead of replaying history.
              if (url.searchParams.get('after') === 'latest')
                return send({
                  events: [],
                  cursor: latestCursor(auth.username),
                  supportsWait: true,
                });
              const after = Number(url.searchParams.get('after') ?? 0);
              const waitMs = Number(url.searchParams.get('waitMs') ?? 0);
              if (
                !Number.isSafeInteger(after) ||
                after < 0 ||
                !Number.isSafeInteger(waitMs) ||
                waitMs < 0
              )
                fail('after and waitMs must be non-negative safe integers');
              const controller = new AbortController();
              const abort = () => controller.abort();
              res.on('close', abort);
              try {
                return send(await waitForV2Events(auth.username, after, waitMs, controller.signal));
              } finally {
                res.off('close', abort);
              }
            },
          }),
          route({
            method: 'POST',
            path: '/inbox/:id/answer',
            handler: async ({ params }) => {
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
                item: await answerInboxAsync(auth.username, decodeURIComponent(params.id), body),
              });
            },
          }),
        ],
        { path: (url) => url.pathname.slice('/api'.length) },
      )(req, res, undefined)
    )
      return;
    // A feature selected by the registry may decline; a standalone entry must let every
    // other leaf try the request and then end it with the registry's 404/405.
    if (feature) return false;
    const { apiRoutes } = await import('../api/registry.ts');
    const url = new URL(req.url!, 'http://localhost');
    return apiRoutes({
      req,
      res,
      url,
      path: url.pathname,
      workspacePath: url.pathname,
      method: req.method,
    });
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
