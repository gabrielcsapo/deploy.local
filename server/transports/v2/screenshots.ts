import { dispatch, routes } from '../../kernel/routes.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Markup, Screenshot } from '../../../shared/v2/contracts.ts';
import { db, event, get, id, list, now, save } from '../../workspace/store.ts';
import { workerAuthentication } from '../../workspace/credentials.ts';
import { workerRole } from '../../workspace/computer-roles.ts';
import { startRun } from '../../workspace/service.ts';
import { queueTask } from '../../workspace/task-workspace.ts';
import { fail } from '../../kernel/errors.ts';
import {
  sendAgentMessage,
  attachmentsApi,
  attachmentBytes,
  attachmentRecord,
  bindRunAttachments,
  chatModel,
  ownedAttachments,
  readJson,
  sendJson,
  storeAttachment,
} from '../../v2/attachments.ts';

export function validateMarkup(value: any): Markup {
  const point = (n: any) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10000;
  const color = (n: any) => [0, 1, 2].includes(n);
  if (
    !value ||
    !Array.isArray(value.strokes) ||
    !Array.isArray(value.texts) ||
    value.strokes.length > 200 ||
    value.texts.length > 100
  )
    fail('Invalid markup');
  let points = 0;
  for (const stroke of value.strokes) {
    if (
      !['pen', 'arrow'].includes(stroke.tool) ||
      !color(stroke.color) ||
      !Array.isArray(stroke.points) ||
      stroke.points.length < 2 ||
      stroke.points.some((p: any) => !Array.isArray(p) || p.length !== 2 || !p.every(point))
    )
      fail('Invalid stroke');
    points += stroke.points.length;
  }
  if (points > 10000) fail('Too many markup points');
  for (const text of value.texts)
    if (
      !point(text.x) ||
      !point(text.y) ||
      !color(text.color) ||
      typeof text.text !== 'string' ||
      !text.text.trim() ||
      text.text.length > 500
    )
      fail('Invalid markup text');
  return {
    strokes: value.strokes.map((s: any) => ({ tool: s.tool, color: s.color, points: s.points })),
    texts: value.texts.map((t: any) => ({ x: t.x, y: t.y, text: t.text, color: t.color })),
  };
}
export function validateTarget(target: any): Screenshot['target'] {
  if (!target || !['web', 'ios-simulator', 'desktop'].includes(target.kind))
    fail('Choose web, iOS simulator or desktop');
  if (target.kind === 'web') {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      fail('Enter the app’s HTTP or HTTPS address');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      fail('Invalid app address');
    return { kind: 'web', url: url.href };
  }
  if (typeof target.device !== 'string' || !target.device || target.device.length > 200)
    fail('Choose the simulator or window');
  if (target.kind === 'ios-simulator' && !/^[a-f0-9-]{36}$/i.test(target.device))
    fail('Use a simulator UUID');
  return { kind: target.kind, device: target.device };
}
function desktopPermission(owner: string, task: any, target: Screenshot['target']) {
  if (target.kind !== 'desktop') return;
  if (!workerRole(owner, task.workerId || 'local', 'use-screen'))
    fail('This computer does not have Use the screen permission', 403);
  const allowed = list('interactive-session', owner).some(
    (s) =>
      s.taskId === task.id &&
      s.workerId === (task.workerId || 'local') &&
      s.kind === 'computer' &&
      s.targetId === target.device &&
      s.status === 'active' &&
      s.expiresAt > Date.now() &&
      Date.now() - Date.parse(s.heartbeat || s.createdAt) < 8000,
  );
  if (!allowed) fail('Approve Use the screen for this task and window first', 403);
}
export function queueScreenshots(owner: string, taskId: string, body: any) {
  const task = get('task', owner, taskId);
  const target = validateTarget(body.target);
  const widths = body.widths ?? [390, 1440];
  if (
    !Array.isArray(widths) ||
    widths.length < 1 ||
    widths.length > 3 ||
    widths.some((w) => !Number.isInteger(w) || w < 320 || w > 2560) ||
    new Set(widths).size !== widths.length
  )
    fail('Choose one to three distinct widths between 320 and 2560');
  desktopPermission(owner, task, target);
  if (
    list('screenshot-request', owner).some(
      (r) =>
        r.taskId === taskId && r.expiresAt > Date.now() && ['queued', 'running'].includes(r.status),
    )
  )
    fail('Screenshots are already being taken', 409);
  return save('screenshot-request', owner, {
    id: id(),
    taskId,
    workerId: task.workerId || 'local',
    target,
    widths: target.kind === 'web' ? widths : [widths[0]],
    status: 'queued',
    createdAt: now(),
    expiresAt: Date.now() + 60000,
  });
}
export function screenshotWorker(owner: string, workerId: string, action: string, body: any) {
  return db
    .transaction(() => {
      if (action === 'poll') {
        const request = list('screenshot-request', owner).find(
          (r) => r.workerId === workerId && r.status === 'queued' && r.expiresAt > Date.now(),
        );
        if (!request) return { request: null };
        const task = get('task', owner, request.taskId);
        if ((task.workerId || 'local') !== workerId) fail('Task moved to another computer', 409);
        desktopPermission(owner, task, request.target);
        return {
          request: save('screenshot-request', owner, {
            ...request,
            status: 'running',
            lease: id(),
          }),
        };
      }
      const request = get('screenshot-request', owner, body.id);
      if (request.workerId !== workerId || request.lease !== body.lease)
        fail('Screenshot request belongs to another worker', 403);
      if (request.status !== 'running' || request.expiresAt < Date.now())
        fail('Screenshot request expired', 409);
      const task = get('task', owner, request.taskId);
      if ((task.workerId || 'local') !== workerId) fail('Task moved to another computer', 409);
      desktopPermission(owner, task, request.target);
      if (body.error) {
        save('screenshot-request', owner, {
          ...request,
          status: 'failed',
          error: String(body.error).slice(0, 500),
        });
        return { ok: true };
      }
      if (!Array.isArray(body.images) || body.images.length !== request.widths.length)
        fail('Missing screenshot images');
      const screenshots = body.images.map((image: any, i: number) => {
        if (
          !['image/png', 'image/jpeg'].includes(image.type) ||
          typeof image.data !== 'string' ||
          image.data.length > 14 * 1024 * 1024 ||
          !Number.isInteger(image.width) ||
          !Number.isInteger(image.height) ||
          image.width < 1 ||
          image.height < 1 ||
          image.width > 10000 ||
          image.height > 10000
        )
          fail('Invalid screenshot');
        if (request.target.kind === 'web' && image.width !== request.widths[i])
          fail('Screenshot width does not match the request');
        const attachment = storeAttachment(
          owner,
          Buffer.from(image.data, 'base64'),
          image.type,
          `screenshot-${request.widths[i]}.${image.type === 'image/png' ? 'png' : 'jpg'}`,
          'screenshot',
        );
        const shot = save('screenshot', owner, {
          id: id(),
          taskId: request.taskId,
          target: request.target,
          takenAt: now(),
          requestedAt: request.createdAt,
          image: attachment.ref,
          width: image.width,
          height: image.height,
          workerId,
        });
        event(owner, request.taskId, null, 'v2.conversation', {
          event: {
            kind: 'screenshot',
            id: `screenshot:${shot.id}`,
            at: shot.takenAt,
            screenshotId: shot.id,
          },
        });
        return shot;
      });
      save('screenshot-request', owner, { ...request, status: 'complete', screenshots });
      return { screenshots };
    })
    .immediate();
}
export function patchScreenshot(owner: string, screenshotId: string, body: any) {
  const shot = get('screenshot', owner, screenshotId);
  const markup = validateMarkup(body.markup);
  let renderedImage: string | undefined;
  if (body.renderedImage) {
    const record = attachmentRecord(owner, body.renderedImage);
    if (!record.type.startsWith('image/')) fail('Markup must be rendered as an image');
    renderedImage = record.attachment.ref;
    save('v2-attachment', owner, {
      ...record,
      attachment: { ...record.attachment, kind: 'screenshot' },
      screenshotId,
      markup,
    });
  }
  return save('screenshot', owner, { ...shot, markup, renderedImage });
}
export function sendTaskMessage(owner: string, taskId: string | undefined, body: any) {
  const attachments = ownedAttachments(owner, body.attachments || []);
  const settings = chatModel(owner, body.model);
  const content = typeof body.text === 'string' ? body.text.trim() : '';
  if (!content || content.length > 100000) fail('Message required (maximum 100000 characters)');
  return db
    .transaction(() => {
      const task = taskId
        ? get('task', owner, taskId)
        : queueTask(owner, {
            title: content.slice(0, 80),
            projectId: body.projectId,
            // Place the task on a computer that runs the chosen provider.
            ...(settings.adapter ? { adapter: settings.adapter } : {}),
            // A task started on a branch, such as a pull request's, checks out that branch.
            ...(body.projectId && body.ref !== undefined ? { ref: body.ref } : {}),
          });
      const run = startRun(owner, task.id, {
        revision: body.revision ?? task.revision,
        content,
        ...settings,
      });
      bindRunAttachments(owner, run, attachments);
      return { taskId: task.id, runId: run.id };
    })
    .immediate();
}
export async function screenshotsApi(
  req: IncomingMessage,
  res: ServerResponse,
  requireAuth: (req: IncomingMessage, res: ServerResponse) => { username: string } | null,
) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (
    !/^\/api\/(conversation-attachments(?:\/|$)|screenshots(?:\/|$)|tasks\/[^/]+\/screenshots$|composer(?:\/|$))/.test(
      path,
    )
  )
    return false;
  const route = routes<undefined>();
  // Workers reach only these POST routes before the client credential check.
  if (
    await dispatch([
      route({
        method: 'POST',
        path: '/api/screenshots/worker/:action(poll|complete|attachments)',
        handler: async ({ params }) => {
          const worker = workerAuthentication(req);
          if (!worker) fail('Worker authentication required', 401);
          const body = await readJson(req, 42 * 1024 * 1024);
          if (params.action === 'attachments') {
            const run = get('run', worker.owner, body.runId);
            if (
              run.workerId !== worker.workerId ||
              !['queued', 'starting', 'running'].includes(run.status)
            )
              fail('Run is not assigned to this worker', 403);
            return sendJson(res, {
              attachments: await Promise.all(
                (run.attachments || []).map(async (a: any) => {
                  const r = await attachmentBytes(worker.owner, a.ref);
                  return { ...a, type: r.type, data: r.bytes.toString('base64'), markup: r.markup };
                }),
              ),
            });
          }
          return sendJson(
            res,
            screenshotWorker(worker.owner, worker.workerId, params.action, body),
          );
        },
      }),
    ])(req, res, undefined)
  )
    return true;
  if (
    req.headers['x-deploy-agent-token'] ||
    req.headers['x-deploy-worker-token'] ||
    workerAuthentication(req)
  )
    fail('Client credentials required', 403);
  const auth = requireAuth(req, res);
  if (!auth) return true;
  const owner = auth.username;
  if (await attachmentsApi(req, res, owner)) return true;
  const task = path.match(/^\/api\/tasks\/([^/]+)\/screenshots$/);
  if (task) {
    const taskId = decodeURIComponent(task[1]);
    get('task', owner, taskId);
    if (
      await dispatch([
        route({
          method: 'GET',
          path: '/api/tasks/:task/screenshots',
          handler: () =>
            sendJson(res, {
              screenshots: list('screenshot', owner).filter((s) => s.taskId === taskId),
            }),
        }),
        route({
          method: 'POST',
          path: '/api/tasks/:task/screenshots',
          handler: async () => {
            const body = await readJson(req);
            const request = queueScreenshots(owner, taskId, body);
            if (typeof body.text === 'string' && body.text.trim() && body.text.length <= 12000) {
              const message = {
                id: id(),
                taskId,
                role: 'user',
                content: body.text.trim(),
                createdAt: now(),
                attachments: [],
              };
              save('message', owner, message);
              event(owner, taskId, null, 'message', message);
            }
            while (!res.destroyed && Date.now() < request.expiresAt) {
              const current = get('screenshot-request', owner, request.id);
              if (current.status === 'complete')
                return sendJson(res, { screenshots: current.screenshots });
              if (current.status === 'failed') fail(current.error, 502);
              await delay(200);
            }
            save('screenshot-request', owner, {
              ...get('screenshot-request', owner, request.id),
              status: 'expired',
            });
            if (!res.destroyed)
              fail(
                'The task’s computer did not finish the screenshots. Check that it is online and try again.',
                504,
              );
            return true;
          },
        }),
      ])(req, res, undefined)
    )
      return true;
  }
  return dispatch(
    [
      route({
        method: 'GET',
        path: '/api/screenshots/:id',
        handler: ({ params }) =>
          sendJson(res, { screenshot: get('screenshot', owner, decodeURIComponent(params.id)) }),
      }),
      route({
        method: 'PATCH',
        path: '/api/screenshots/:id',
        handler: async ({ params }) =>
          sendJson(res, {
            screenshot: patchScreenshot(
              owner,
              decodeURIComponent(params.id),
              await readJson(req, 1024 * 1024),
            ),
          }),
      }),
      route({
        method: 'POST',
        path: '/api/composer/agents/:agent/messages',
        handler: async ({ params }) =>
          sendJson(
            res,
            await sendAgentMessage(owner, decodeURIComponent(params.agent), await readJson(req)),
          ),
      }),
      route({
        method: 'POST',
        path: '/api/composer/messages',
        handler: async () => {
          const body = await readJson(req);
          return sendJson(res, sendTaskMessage(owner, body.taskId, body), 201);
        },
      }),
    ],
    { notFound: () => sendJson(res, { error: 'Not found' }, 404) },
  )(req, res, undefined);
}
