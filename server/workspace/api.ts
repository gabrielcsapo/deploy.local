import { taskPullSummary, taskPublishDefaults } from './task-presentation.ts';
import { publishTask } from './publish.ts';
import { taskFiles } from './task-files.ts';
import {
  interactiveRead,
  interactiveSnapshot,
  interactiveOperator,
  interactiveWorker,
} from './interactive.ts';
import { transcribe, transcriptionAvailable } from './transcription.ts';
import { pipelineStart, pipelineRead, pipelineCancel } from './pipelines.ts';
import { collaborationRead, collaborationCommand } from './project-collaboration.ts';
import { queueTask, taskWorkspaceCommand } from './task-workspace.ts';
import { repositorySetup } from './repository-setup.ts';
import {
  queueProject,
  updateProjectSettings,
  repositoryCommand,
  repositoryInfo,
  repositoryRead,
  requireRepository,
} from './repositories.ts';
import { describeJob, jobCommand, issueAgentToken, coordinationTool } from './coordination.ts';
import { queueCheck } from './checks.ts';
import { enrollWorker } from './credentials.ts';
import { createHash } from 'node:crypto';
import { workerCommand } from './protocol.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveRepositoryGit } from './git-http.ts';
import { serveRepositoryLfs } from './repository-lfs.ts';
import { list, get, command, cursor, recentEvents, activityEvents } from './store.ts';
import { projectActivity } from './activity.ts';
import { waitForEvents } from './event-feed.ts';
import { taskQuestions, answerQuestion } from './questions.ts';
import { startRun, stopRun, setTaskOutcome, diff, turnDiff, capabilities } from './service.ts';
import { queueMessage, cancelQueuedMessage, queuedMessage } from './queued-message.ts';
import { managedWorkerStatus, enableManagedWorker } from './managed-worker.ts';
import {
  providerConnections,
  saveProviderConnection,
  requestProviderLogin,
  updateProviderLogin,
} from './provider-connections.ts';
export async function workspaceApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  workerIdentity?: string,
) {
  const url = new URL(req.url!, 'http://localhost'),
    path = url.pathname.slice('/api/workspace'.length),
    method = req.method;
  const send = (value: any, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    if (workerIdentity) {
      const workerPath = '/workers/' + workerIdentity + '/';
      if (
        !(path === '/workers/register' || path.startsWith(workerPath) || path.startsWith('/git/'))
      )
        throw Object.assign(new Error('Worker credential cannot access client commands'), {
          status: 403,
        });
    }
    if (path === '/transcription' && method === 'GET')
      return send({ available: transcriptionAvailable() });
    if (path === '/transcription' && method === 'POST') return await transcribe(req, res, owner);
    if (path.startsWith('/git/')) {
      const match = path.match(/^\/git\/([^/]+)(\/.*)?$/);
      if (!match) throw new Error('Invalid repository path');
      const project = requireRepository(owner, match[1].replace(/\.git$/, ''));
      const lfs = match[2]?.startsWith('/info/lfs/');
      if (workerIdentity) {
        if (!lfs && method !== 'GET' && !(method === 'POST' && match[2] === '/git-upload-pack'))
          throw Object.assign(new Error('Workers have read-only Git transport'), { status: 403 });
        if (
          url.searchParams.get('service') &&
          url.searchParams.get('service') !== 'git-upload-pack'
        )
          throw Object.assign(new Error('Workers cannot push hosted repositories'), {
            status: 403,
          });
        const allowed = list('run', owner).some(
          (r) =>
            r.workerId === workerIdentity &&
            ['starting', 'running', 'unknown'].includes(r.status) &&
            get('task', owner, r.taskId).projectId === project.id,
        );
        const assignedJob = list('job', owner).some(
          (job) =>
            job.workerId === workerIdentity &&
            job.status === 'running' &&
            job.projectId === project.id,
        );
        if (!allowed && !assignedJob)
          throw Object.assign(new Error('Repository is not assigned to this worker'), {
            status: 403,
          });
      }
      if (lfs)
        return await serveRepositoryLfs(
          req,
          res,
          owner,
          project.id,
          match[2],
          Boolean(workerIdentity),
        );
      serveRepositoryGit(req, res, project, match[2] || '/', url, owner);
      return;
    }
    const pipelineRoute = path.match(
      /^\/projects\/([^/]+)\/pipelines(?:\/([^/]+)(?:\/(cancel))?)?$/,
    );
    const collaborationRoute = path.match(
      /^\/projects\/([^/]+)\/(issues|pulls)(?:\/([^/]+)(?:\/(diff|update|close|reopen|comments|merge|retry-merge|task))?)?$/,
    );
    const controlRoute = path.match(/^\/tasks\/([^/]+)\/controls(?:\/([^/]+))?$/);
    if (method === 'GET') {
      const settingsRoute = path.match(/^\/projects\/([^/]+)\/settings$/);
      if (settingsRoute) {
        const project = get('project', owner, settingsRoute[1]);
        return send({
          id: project.id,
          name: project.name,
          description: project.description || '',
          settingsRevision: project.settingsRevision || 0,
        });
      }
      if (path === '/provider-connections')
        return send({
          managed: managedWorkerStatus(owner),
          workers: list('worker', owner).map((worker) => ({
            ...worker,
            providerStatus: worker.connections || [],
            connections: providerConnections(owner, worker.id),
            login: list('provider-login', owner).find((login) => login.id === worker.id) || null,
          })),
        });
      if (controlRoute)
        return send(
          controlRoute[2]
            ? interactiveSnapshot(owner, controlRoute[1], controlRoute[2])
            : interactiveRead(owner, controlRoute[1]),
        );
      if (pipelineRoute && !pipelineRoute[3])
        return send(pipelineRead(owner, pipelineRoute[1], pipelineRoute[2]));
      if (collaborationRoute) {
        if (collaborationRoute[4] && collaborationRoute[4] !== 'diff')
          return send({ error: 'Not found' }, 404);
        return send(
          await collaborationRead(
            owner,
            collaborationRoute[1],
            collaborationRoute[2],
            collaborationRoute[3],
            collaborationRoute[4],
            url.searchParams,
          ),
        );
      }
      if (path === '/repositories/setup') return send(await repositorySetup(owner));
      if (path === '/application-repositories') {
        const application = url.searchParams.get('application');
        if (!application) throw new Error('Application required');
        const projects = [];
        for (const project of list('project', owner)) {
          const repository = await repositoryInfo(owner, project.id);
          if ('deployment' in repository && repository.deployment.application === application)
            projects.push({ id: project.id, name: project.name });
        }
        return send({ projects });
      }
      const repositoryRoute = path.match(
        /^\/projects\/([^/]+)\/repository(?:\/(tree|blob|history|diff|files|entry))?$/,
      );
      if (repositoryRoute)
        return send(
          repositoryRoute[2]
            ? await repositoryRead(owner, repositoryRoute[1], repositoryRoute[2], url.searchParams)
            : await repositoryInfo(owner, repositoryRoute[1]),
        );
      if (path === '/state') {
        const pulls = list('pull-request', owner);
        return send({
          version: 1,
          cursor: cursor(owner),
          projects: list('project', owner),
          tasks: list('task', owner).map((task) => taskPullSummary(task, pulls)),
          runs: list('run', owner),
          ...capabilities(owner),
        });
      }
      if (path === '/events') {
        const after = Number(url.searchParams.get('after') || 0);
        const waitMs = Number(url.searchParams.get('waitMs') || 0);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(waitMs) || waitMs < 0)
          return send({ error: 'Invalid event cursor or wait duration' }, 400);
        const controller = new AbortController();
        const closed = () => controller.abort();
        res.once('close', closed);
        try {
          const page = await waitForEvents(
            owner,
            after,
            url.searchParams.get('taskId') || undefined,
            waitMs,
            controller.signal,
          );
          if (!res.destroyed) return send(page);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          res.off('close', closed);
        }
        return;
      }
      const files = path.match(/^\/tasks\/([^/]+)\/files(\/content)?$/);
      if (files) return send(await taskFiles(owner, files[1], Boolean(files[2]), url.searchParams));
      const m = path.match(/^\/tasks\/([^/]+)(\/diff)?$/);
      if (m) {
        const task = get('task', owner, m[1]);
        if (m[2])
          return send(
            url.searchParams.get('scope') === 'turn'
              ? turnDiff(owner, task.id)
              : diff(owner, task.id),
          );
        const runs = list('run', owner).filter((r) => r.taskId === task.id);
        const messages = list('message', owner).filter((message) => message.taskId === task.id);
        return send({
          task: taskPullSummary(task, list('pull-request', owner)),
          publishDefaults: taskPublishDefaults(owner, task),
          preparation: task.workspaceOperationId
            ? get('repository-operation', owner, task.workspaceOperationId)
            : null,
          issues: list('issue', owner).filter(
            (row) => row.projectId === task.projectId && row.taskIds.includes(task.id),
          ),
          pullRequests: list('pull-request', owner).filter(
            (row) => row.projectId === task.projectId && row.taskIds.includes(task.id),
          ),
          ...projectActivity(activityEvents(owner, task.id), runs, messages),
          runs,
          queuedMessage: queuedMessage(owner, task.id),
          questions: taskQuestions(owner, task.id),
          jobs: list('job', owner)
            .filter((r) => r.taskId === task.id)
            .map((job) => describeJob(owner, job)),
          events: recentEvents(owner, task.id),
          cursor: cursor(owner),
        });
      }
    }
    if (method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (
          Buffer.byteLength(raw) >
          (path.match(/^\/workers\/[^/]+\/controls\/complete$/) ? 2000000 : 512000)
        )
          throw new Error('Request too large');
      }
      const body = JSON.parse(raw || '{}');
      if (workerIdentity && path === '/workers/register' && body.workerId !== workerIdentity)
        throw Object.assign(new Error('Worker identity mismatch'), { status: 403 });
      if (controlRoute && controlRoute[2])
        return send(interactiveOperator(owner, controlRoute[1], controlRoute[2], body));
      const controlWorker = path.match(
        /^\/workers\/([^/]+)\/controls\/(poll|claim|complete|fail)$/,
      );
      if (controlWorker)
        return send(interactiveWorker(owner, controlWorker[1], controlWorker[2], body));
      const cancelJob = path.match(/^\/tasks\/([^/]+)\/jobs\/([^/]+)\/cancel$/);
      if (cancelJob) {
        const job = get('job', owner, cancelJob[2]);
        return send(
          coordinationTool({ owner, taskId: cancelJob[1], runId: job.runId }, 'deploy_cancel_job', {
            jobId: job.id,
            operationId: body.operationId,
          }),
        );
      }
      const jobRoute = path.match(/^\/workers\/([^/]+)\/jobs\/(poll|update|complete)$/);
      if (jobRoute) return send(jobCommand(owner, jobRoute[1], jobRoute[2], body));
      if (path.startsWith('/workers/') && path !== '/workers/enroll') {
        const result = workerCommand(owner, path, body);
        if (result !== undefined) {
          if (path.endsWith('/poll') && result.run && result.run.status === 'starting')
            return send({
              ...result,
              agentToken: issueAgentToken({
                owner,
                taskId: result.run.taskId,
                runId: result.run.id,
              }),
            });
          return send(result);
        }
      }
      const stable = (value: any): any =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])]),
            )
          : Array.isArray(value)
            ? value.map(stable)
            : value;
      const signature = createHash('sha256')
        .update(path + JSON.stringify(stable(body)))
        .digest('hex');
      if (path === '/workers/managed/start')
        return send(command(owner, body.operationId, () => enableManagedWorker(owner), signature));
      if (path === '/provider-connections')
        return send(
          command(owner, body.operationId, () => saveProviderConnection(owner, body), signature),
        );
      if (path === '/provider-connections/login')
        return send(
          command(
            owner,
            body.operationId,
            () => requestProviderLogin(owner, body.workerId),
            signature,
          ),
        );
      const providerRoute = path.match(/^\/workers\/([^/]+)\/(provider-config|provider-login)$/);
      if (providerRoute) {
        get('worker', owner, providerRoute[1]);
        return send(
          providerRoute[2] === 'provider-config'
            ? {
                connections: providerConnections(owner, providerRoute[1], true),
                login:
                  list('provider-login', owner).find((login) => login.id === providerRoute[1]) ||
                  null,
              }
            : updateProviderLogin(owner, providerRoute[1], body),
        );
      }
      if (pipelineRoute) {
        if (!pipelineRoute[2])
          return send(
            await pipelineStart(owner, pipelineRoute[1], { ...body, trigger: 'manual' }, signature),
            202,
          );
        if (pipelineRoute[3] === 'cancel')
          return send(
            command(
              owner,
              body.operationId,
              () => pipelineCancel(owner, pipelineRoute[1], pipelineRoute[2]),
              signature,
            ),
          );
      }
      if (collaborationRoute) {
        const result = await collaborationCommand(
          owner,
          collaborationRoute[1],
          collaborationRoute[2],
          collaborationRoute[3],
          collaborationRoute[4],
          body,
          signature,
        );
        return send(result, ['merge', 'retry-merge'].includes(collaborationRoute[4]) ? 202 : 200);
      }
      const publishRoute = path.match(/^\/tasks\/([^/]+)\/publish$/);
      if (publishRoute) return send(await publishTask(owner, publishRoute[1], body, signature));
      const result = command(
        owner,
        body.operationId,
        () => {
          if (path === '/workers/enroll') return enrollWorker(owner, body);
          if (path === '/projects') return queueProject(owner, body);
          const settingsRoute = path.match(/^\/projects\/([^/]+)\/settings$/);
          if (settingsRoute) return updateProjectSettings(owner, settingsRoute[1], body);
          const repositoryRoute = path.match(
            /^\/projects\/([^/]+)\/repository\/(fetch|retry|cancel)$/,
          );
          if (repositoryRoute)
            return repositoryCommand(owner, repositoryRoute[1], repositoryRoute[2]);
          if (path === '/tasks') return queueTask(owner, body);
          const questionRoute = path.match(/^\/tasks\/([^/]+)\/questions\/([^/]+)\/answer$/);
          if (questionRoute) return answerQuestion(owner, questionRoute[1], questionRoute[2], body);
          const workspaceRoute = path.match(/^\/tasks\/([^/]+)\/workspace\/(retry|cancel)$/);
          if (workspaceRoute)
            return taskWorkspaceCommand(owner, workspaceRoute[1], workspaceRoute[2]);
          const queueRoute = path.match(/^\/tasks\/([^/]+)\/queue(\/cancel)?$/);
          if (queueRoute)
            return queueRoute[2]
              ? cancelQueuedMessage(owner, queueRoute[1])
              : queueMessage(owner, queueRoute[1], body);
          const m = path.match(/^\/tasks\/([^/]+)\/(messages|stop|check|close|reopen)$/);
          if (m) {
            if (m[2] === 'messages') return startRun(owner, m[1], body);
            if (m[2] === 'stop') return stopRun(owner, m[1], body);
            if (m[2] === 'close' || m[2] === 'reopen')
              return setTaskOutcome(owner, m[1], m[2], body);
            return queueCheck(owner, m[1], body);
          }
          throw Object.assign(new Error('Not found'), { status: 404 });
        },
        signature,
      );
      if (/^\/projects\/[^/]+\/repository\/(fetch|retry|cancel)$/.test(path))
        return send(get('repository-operation', owner, result.id));
      if (path === '/tasks') {
        const task = get('task', owner, result.id);
        return send(task, task.workspaceStatus === 'preparing' ? 202 : 200);
      }
      if (/^\/tasks\/[^/]+\/workspace\/(retry|cancel)$/.test(path))
        return send(get('repository-operation', owner, result.id));
      if (path === '/projects') {
        const project = get('project', owner, result.id);
        return send(project, project.repositoryStatus === 'ready' ? 200 : 202);
      }
      return send(path.endsWith('/check') && result.id ? get('check', owner, result.id) : result);
    }
    send({ error: 'Not found' }, 404);
  } catch (error: any) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    send({ error: error.message }, error.status || 400);
  }
}
