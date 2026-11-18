import { readWorkspaceState } from '../../workspace/read-state.ts';
import { dispatch, routes } from '../../kernel/routes.ts';
import { requireRepositoryProjectCreator } from '../../workspace/repository-project-port.ts';
import { plainPath, sendJson } from '../../kernel/http.ts';
import type { TaskDetail, Message } from '../../../shared/v2/contracts.ts';
import { updateBase, baseUpdateWorker } from '../../workspace/update-base.ts';
import { taskQueue, moveQueuedRun } from '../../workspace/run-queue.ts';
import { cleanShellMessage } from '../../workspace/shell-commands.ts';
import { terminalClientIp } from './terminal-socket.ts';
import {
  terminalRelay,
  terminalStatus,
  setTerminalPermission,
  shellCommand,
  recoverShellCommands,
} from '../../workspace/terminal-service.ts';
import { addSshKey, deleteSshKey } from '../../workspace/ssh-keys.ts';
import { sshServerInfo } from '../../workspace/ssh-host.ts';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { latestCheckpointSummary } from '../../workspace/checkpoint-publish.ts';
import { recordingRequest } from './recording-upload.ts';
import { jobArtifactRequest } from '../../workspace/job-artifacts.ts';
import { taskAttachments, uploadAttachment, serveAttachment } from '../../workspace/attachments.ts';
import { taskPullSummary, taskPublishDefaults } from '../../workspace/task-presentation.ts';
import { publishTask } from '../../workspace/publish.ts';
import { deleteTask, taskDeletion } from '../../workspace/task-delete.ts';
// Task files reached managed-worker before; keep its evaluation ahead of them.
import { managedWorkerStatus, enableManagedWorker } from '../../workspace/managed-worker.ts';
import { taskFiles } from '../../workspace/task-files.ts';
import {
  interactiveRead,
  interactiveSnapshot,
  interactiveOperator,
  interactiveWorker,
  pendingControlRequests,
} from '../../workspace/interactive.ts';
import { transcribe, transcriptionAvailable } from '../../workspace/transcription.ts';
import { pipelineStart, pipelineRead, pipelineCancel } from '../../workspace/pipelines.ts';
import {
  collaborationRead,
  collaborationCommand,
  openRemotePull,
} from '../../workspace/project-collaboration.ts';
import { queueTask, taskWorkspaceCommand } from '../../workspace/task-workspace.ts';
import { repositorySetup } from '../../workspace/repository-setup.ts';
import {
  updateProjectSettings,
  updateProjectControlPolicy,
  addProjectRemote,
  repositoryBranches,
  setDefaultBranch,
  repositoryCommand,
  repositoryInfo,
  repositoryRead,
  findRepository,
  streamRepositoryArchive,
} from '../../workspace/repositories.ts';
import { shortGitRequest } from '../../../shared/repository-address.ts';
import {
  describeJob,
  jobSnapshot,
  jobCommand,
  issueAgentToken,
  coordinationTool,
  computers,
  revokeWorker,
} from '../../workspace/coordination.ts';
import { queueCheck } from '../../workspace/checks.ts';
import { enrollWorker, workerAuthentication } from '../../workspace/credentials.ts';
import { operationSignature } from './operation-signature.ts';
import { workerCommand } from '../../workspace/protocol.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveRepositoryGit } from '../../workspace/git-http.ts';
import { serveRepositoryLfs } from '../../workspace/repository-lfs.ts';
import type { LfsCredential } from '../../features/repositories/lfs-ssh-credential.ts';
import {
  repositoryStorage,
  repositoryStorageFiles,
} from '../../features/repositories/repository-storage.ts';
import {
  list,
  get,
  command,
  cursor,
  recentEvents,
  eventsBefore,
  activityEvents,
} from '../../workspace/store.ts';
import { projectActivity } from '../../workspace/activity.ts';
import { waitForEvents } from '../../workspace/event-feed.ts';
import { taskQuestions, tasksWaitingForAnswer, answerQuestion } from '../../workspace/questions.ts';
import {
  startRun,
  stopRun,
  setTaskOutcome,
  diff,
  turnDiff,
  taskFilePatch,
  taskPatch,
} from '../../workspace/service.ts';
import {
  queueMessage,
  cancelQueuedMessage,
  queuedMessage,
} from '../../workspace/queued-message.ts';
import { markRunStopped, presentRun } from '../../workspace/run-recovery.ts';
import {
  providerConnections,
  saveProviderConnection,
  requestProviderLogin,
  updateProviderLogin,
} from '../../workspace/provider-connections.ts';
/**
 * `deploy.local/<repo>.git` (and `/<repo>/info/refs` for clones without the suffix) served as
 * the hosted Git route; a browser opening `/<repo>.git` is sent to the repository's page.
 */
export function shortGitRoute(rawUrl: string, method?: string) {
  const url = new URL(rawUrl, 'http://localhost');
  const request = shortGitRequest(url.pathname);
  if (!request) return null;
  const repository = encodeURIComponent(request.repository);
  if (!request.transport)
    return method === 'GET' || method === 'HEAD' ? { redirect: '/' + repository, url: '' } : null;
  return {
    redirect: '',
    url: `/api/git/${repository}.git${request.transport}${url.search}`,
  };
}
/**
 * A worker reads a hosted repository only while it runs that repository's task or one of its
 * jobs. Job records don't carry the project, so a job counts through its task — checkpoint jobs
 * fetch their base commit this way.
 */
export function workerMayReadRepository(owner: string, workerId: string, projectId: string) {
  const taskProject = (taskId: string) => {
    try {
      return get('task', owner, taskId).projectId;
    } catch {
      return null;
    }
  };
  return (
    list('base-update', owner).some(
      (op) =>
        op.workerId === workerId &&
        op.projectId === projectId &&
        ['queued', 'preparing', 'prepared'].includes(op.status),
    ) ||
    list('run', owner).some(
      (run) =>
        run.workerId === workerId &&
        ['starting', 'running', 'unknown'].includes(run.status) &&
        taskProject(run.taskId) === projectId,
    ) ||
    list('job', owner).some(
      (job) =>
        job.workerId === workerId &&
        job.status === 'running' &&
        (job.projectId ?? taskProject(job.taskId)) === projectId,
    )
  );
}
export async function workspaceApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  workerIdentity?: string,
  /** A Git LFS credential minted over SSH: one repository's LFS routes and nothing else. */
  lfsCredential?: LfsCredential,
) {
  const url = new URL(req.url!, 'http://localhost'),
    // The iPhone app writes a project ID as 37bba42d%2D72d2…; routes match the plain form.
    path = plainPath(url.pathname).slice('/api'.length),
    method = req.method;
  const send = async (value: any, status = 200) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    };
    // An upload rejected partway (size cap, wrong job) has started reading its body, so Node won't
    // drain the rest. Left on a keep-alive socket, the unread bytes sit ahead of the next request
    // the edge pools onto it, which then waits out the idle timeout. Read the rest first; a
    // client still sending after a few seconds gets its connection closed instead.
    if (req.complete === false && !req.destroyed) {
      req.resume();
      await Promise.race([
        once(req, 'end').catch(() => {}),
        delay(5000, undefined, { ref: false }),
      ]);
    }
    // Still unread (or the stream was torn down mid-body): don't let the socket be reused.
    if (req.complete === false) headers.Connection = 'close';
    if (res.destroyed || res.headersSent) return;
    sendJson(res, value, status, { headers });
  };

  const respondError = async (error: any) => {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    await send({ error: error.message }, error.status || 400);
  };
  const route = routes<undefined>();
  const options = { path: () => path, method: () => method };
  try {
    if (lfsCredential && !path.startsWith('/git/'))
      throw Object.assign(new Error('This credential only reaches Git LFS'), { status: 403 });
    if (workerIdentity) {
      const workerPath = '/workers/' + workerIdentity + '/';
      if (
        !(path === '/workers/register' || path.startsWith(workerPath) || path.startsWith('/git/'))
      )
        throw Object.assign(new Error('Worker credential cannot access client commands'), {
          status: 403,
        });
    }
    // Each handler owns the original catch. Returning dispatch without awaiting keeps a returned
    // send promise outside that catch, just as in the original request handler.
    // All remaining POSTs read their body, even unknown paths, before command dispatch.
    const postCommands = async () => {
      try {
        let raw = '';

        // A single run event can carry an image an agent looked at, so event posts get room.
        // A finished turn uploads every changed file's full patch, bounded by `fullPatchLimit`.
        const limit = /\/base-updates\//.test(path)
          ? 96 * 1024 * 1024
          : /^\/workers\/[^/]+\/(?:events|complete)$/.test(path)
            ? 16_000_000
            : /^\/workers\/[^/]+\/controls\/complete$/.test(path)
              ? 2_000_000
              : 512_000;

        // Past the cap, keep reading and drop the rest: leaving it unread would strand it on the
        // keep-alive socket (see `send`).
        let size = 0;

        for await (const chunk of req) {
          size += chunk.length;
          if (size <= limit) raw += chunk;
        }

        if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });

        const body = JSON.parse(raw || '{}');

        return dispatch(
          [
            route({
              method: 'POST',
              path: '/computers/:computer/terminal',
              handler: async ({ params }) => {
                try {
                  if (typeof body.enabled !== 'boolean')
                    return send({ error: 'enabled must be a boolean' }, 400);
                  return send(setTerminalPermission(owner, params.computer, body.enabled));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/workers/register',
              handler: async () => {
                try {
                  if (workerIdentity && body.workerId !== workerIdentity)
                    throw Object.assign(new Error('Worker identity mismatch'), {
                      status: 403,
                    });
                  return false;
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/tasks/:task/controls/:control',
              handler: async ({ params }) => {
                try {
                  return send(interactiveOperator(owner, params.task, params.control, body));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/workers/:worker/controls/:action(poll|claim|complete|fail|recording-error)',
              handler: async ({ params }) => {
                try {
                  return send(interactiveWorker(owner, params.worker, params.action, body));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/tasks/:task/jobs/:job/cancel',
              handler: async ({ params }) => {
                try {
                  const job = get('job', owner, params.job);
                  return send(
                    coordinationTool(
                      { owner, taskId: params.task, runId: job.runId },
                      'deploy_cancel_job',
                      {
                        jobId: job.id,
                        operationId: body.operationId,
                      },
                    ),
                  );
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/workers/:worker/base-updates/:action(poll|prepare|complete|fail)',
              handler: async ({ params }) => {
                try {
                  return send(await baseUpdateWorker(owner, params.worker, params.action, body));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            route({
              method: 'POST',
              path: '/workers/:worker/jobs/:action(poll|update|complete|packages|package-publish)',
              handler: async ({ params }) => {
                try {
                  return send(await jobCommand(owner, params.worker, params.action, body));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
            ...['/workers/', '/workers/:rest*'].map((pattern) =>
              route({
                method: 'POST',
                path: pattern,
                handler: async () => {
                  try {
                    if (path === '/workers/enroll') return false;

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

                    return false;
                  } catch (error: any) {
                    return respondError(error);
                  }
                },
              }),
            ),
          ],
          options,
        )(req, res, undefined).then<void | boolean>((handled) => {
          if (handled) return;
          // Compute the signature only after worker routes fall through. Rejections of their
          // returned send promises bypass this continuation and its catch.
          try {
            const signature = operationSignature(path, body);

            const runCommand = (action: () => any) => {
              const result = command(owner, body.operationId, action, signature);
              if (/^\/projects\/[^/]+\/repository\/(fetch|retry|cancel)$/.test(path))
                return send(get('repository-operation', owner, result.id));
              if (path === '/tasks') {
                const task = get('task', owner, result.id);
                return send(task, task.workspaceStatus === 'preparing' ? 202 : 200);
              }
              if (/^\/tasks\/[^/]+\/workspace\/(retry|cancel)$/.test(path))
                return send(get('repository-operation', owner, result.id));
              if (path === '/repository-projects') {
                const project = get('project', owner, result.id);
                return send(project, project.repositoryStatus === 'ready' ? 200 : 202);
              }
              return send(
                path.endsWith('/check') && result.id ? get('check', owner, result.id) : result,
              );
            };
            return dispatch(
              [
                route({
                  method: 'POST',
                  path: '/repository-projects',
                  handler: async () => {
                    try {
                      const project = await requireRepositoryProjectCreator('workspace')(
                        owner,
                        body,
                        signature,
                      );
                      const stored = get('project', owner, project.id);
                      return send(stored, stored.repositoryStatus === 'ready' ? 200 : 202);
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/workers/managed/start',
                  handler: async () => {
                    try {
                      return send(
                        command(
                          owner,
                          body.operationId,
                          () => enableManagedWorker(owner),
                          signature,
                        ),
                      );
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/provider-connections',
                  handler: async () => {
                    try {
                      return send(
                        command(
                          owner,
                          body.operationId,
                          () => saveProviderConnection(owner, body),
                          signature,
                        ),
                      );
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/provider-connections/login',
                  handler: async () => {
                    try {
                      return send(
                        command(
                          owner,
                          body.operationId,
                          () => requestProviderLogin(owner, body.workerId),
                          signature,
                        ),
                      );
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/workers/:worker/:action(provider-config|provider-login)',
                  handler: async ({ params }) => {
                    try {
                      get('worker', owner, params.worker);
                      return send(
                        params.action === 'provider-config'
                          ? {
                              connections: providerConnections(owner, params.worker, true),
                              login:
                                list('provider-login', owner).find(
                                  (login) => login.id === params.worker,
                                ) || null,
                            }
                          : updateProviderLogin(owner, params.worker, body),
                      );
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                ...[
                  '/projects/:project/pipelines',
                  '/projects/:project/pipelines/:pipeline/:action(cancel)',
                ].map((pattern) =>
                  route({
                    method: 'POST',
                    path: pattern,
                    handler: async ({ params: matched }) => {
                      const params = matched as Record<string, string>;
                      try {
                        if (!params.pipeline)
                          return send(
                            await pipelineStart(
                              owner,
                              params.project,
                              { ...body, trigger: 'manual' },
                              signature,
                            ),
                            202,
                          );
                        if (params.action === 'cancel')
                          return send(
                            command(
                              owner,
                              body.operationId,
                              () => pipelineCancel(owner, params.project, params.pipeline),
                              signature,
                            ),
                          );
                      } catch (error: any) {
                        return respondError(error);
                      }
                    },
                  }),
                ),
                ...[
                  '/projects/:project/:kind(issues|pulls)',
                  '/projects/:project/:kind(issues|pulls)/:item',
                  '/projects/:project/:kind(issues|pulls)/:item/:action(diff|update|close|reopen|comments|merge|retry-merge|task|accept)',
                ].map((pattern) =>
                  route({
                    method: 'POST',
                    path: pattern,
                    handler: async ({ params: matched }) => {
                      const params = matched as Record<string, string>;
                      try {
                        const result = await collaborationCommand(
                          owner,
                          params.project,
                          params.kind,
                          params.item,
                          params.action,
                          body,
                          signature,
                        );
                        return send(
                          result,
                          ['merge', 'retry-merge'].includes(params.action) ? 202 : 200,
                        );
                      } catch (error: any) {
                        return respondError(error);
                      }
                    },
                  }),
                ),
                route({
                  method: 'POST',
                  path: '/projects/:project/repository/default-branch',
                  handler: async ({ params }) => {
                    try {
                      return send(await setDefaultBranch(owner, params.project, body));
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/repository/remote-pull',
                  handler: async ({ params }) => {
                    try {
                      return send(await openRemotePull(owner, params.project, body, signature));
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/update-base',
                  handler: async ({ params }) => {
                    try {
                      return send(await updateBase(owner, params.task, body));
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/publish',
                  handler: async ({ params }) => {
                    try {
                      return send(await publishTask(owner, params.task, body, signature));
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/ssh-keys',
                  handler: async () => {
                    try {
                      return runCommand(() => {
                        return addSshKey(owner, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/ssh-keys/:key/delete',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return deleteSshKey(owner, params.key);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/workers/enroll',
                  handler: async () => {
                    try {
                      return runCommand(() => {
                        return enrollWorker(owner, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/computers/:computer/revoke',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return revokeWorker(owner, params.computer);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/settings',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return updateProjectSettings(owner, params.project, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/settings/control',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return updateProjectControlPolicy(owner, params.project, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/repository/:action(fetch|retry|cancel)',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return repositoryCommand(owner, params.project, params.action);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/repository/remote',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return addProjectRemote(owner, params.project, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks',
                  handler: async () => {
                    try {
                      return runCommand(() => {
                        return queueTask(owner, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/shell',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return shellCommand(owner, params.task, body, {
                          ip: terminalClientIp(req),
                          userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
                        });
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/questions/:question/answer',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return answerQuestion(owner, params.task, params.question, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/move',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return moveQueuedRun(owner, params.task, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                route({
                  method: 'POST',
                  path: '/tasks/:task/workspace/:action(retry|cancel)',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        return taskWorkspaceCommand(owner, params.task, params.action);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
                ...['/tasks/:task/queue', '/tasks/:task/queue/:cancel(cancel)'].map((pattern) =>
                  route({
                    method: 'POST',
                    path: pattern,
                    handler: async ({ params: matched }) => {
                      const params = matched as Record<string, string>;
                      try {
                        return runCommand(() => {
                          return params.cancel
                            ? cancelQueuedMessage(owner, params.task)
                            : queueMessage(owner, params.task, body);
                        });
                      } catch (error: any) {
                        return respondError(error);
                      }
                    },
                  }),
                ),
                route({
                  method: 'POST',
                  path: '/tasks/:task/:action(messages|stop|mark-stopped|check|close|reopen|delete)',
                  handler: async ({ params }) => {
                    try {
                      return runCommand(() => {
                        if (params.action === 'messages') return startRun(owner, params.task, body);
                        if (params.action === 'stop') return stopRun(owner, params.task, body);
                        if (params.action === 'mark-stopped')
                          return markRunStopped(owner, params.task, body);
                        if (params.action === 'close' || params.action === 'reopen')
                          return setTaskOutcome(owner, params.task, params.action, body);
                        if (params.action === 'delete') return deleteTask(owner, params.task, body);
                        return queueCheck(owner, params.task, body);
                      });
                    } catch (error: any) {
                      return respondError(error);
                    }
                  },
                }),
              ],
              {
                ...options,
                notFound: async () => {
                  try {
                    return runCommand(() => {
                      throw Object.assign(new Error('Not found'), { status: 404 });
                    });
                  } catch (error: any) {
                    return respondError(error);
                  }
                },
              },
            )(req, res, undefined);
          } catch (error: any) {
            return respondError(error);
          }
        });
      } catch (error: any) {
        return respondError(error);
      }
    };
    return dispatch(
      [
        route({
          method: 'GET',
          path: '/computers/:computer/terminal',
          handler: async ({ params }) => {
            try {
              return send(terminalStatus(owner, params.computer));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/workers/:worker/terminals',
          handler: async ({ params }) => {
            try {
              if (workerIdentity !== params.worker)
                return send({ error: 'Worker credential required' }, 403);
              const worker = get('worker', owner, workerIdentity);
              const instance = url.searchParams.get('instanceId') || '';
              if (worker.revokedAt || worker.instanceId !== instance)
                return send({ error: 'Worker process changed' }, 403);
              const abort = new AbortController();
              const close = () => abort.abort();
              res.once('close', close);
              try {
                const assignments = await terminalRelay.poll(
                  owner,
                  workerIdentity,
                  instance,
                  abort.signal,
                );
                const current = workerAuthentication(req);
                if (!current || current.owner !== owner || current.workerId !== workerIdentity)
                  return send({ error: 'Worker credential changed' }, 403);
                return await send(assignments);
              } finally {
                res.removeListener('close', close);
              }
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'POST',
          path: '/workers/:worker/controls/:control/recording',
          handler: async ({ params }) => {
            try {
              return send(await recordingRequest(req, owner, params.worker, params.control));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'POST',
          path: '/workers/:worker/jobs/:job/artifacts',
          handler: async ({ params }) => {
            try {
              return send(
                await jobArtifactRequest(
                  req,
                  owner,
                  params.worker,
                  params.job,
                  url.searchParams,
                  workerIdentity,
                ),
              );
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'POST',
          path: '/tasks/:task/attachments',
          handler: async ({ params }) => {
            try {
              return send(await uploadAttachment(req, owner, params.task, url.searchParams));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/attachments/:attachment', '/attachments/:attachment/thumbnail'].map((pattern) =>
          route({
            method: ['GET', 'HEAD'],
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                return await serveAttachment(req, res, owner, params.attachment);
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/transcription',
          handler: async () => {
            try {
              return send({ available: transcriptionAvailable() });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'POST',
          path: '/transcription',
          handler: async () => {
            try {
              return await transcribe(req, res, owner);
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/git/', '/git/:rest*'].map((pattern) =>
          route({
            method: '*',
            path: pattern,
            handler: async () => {
              try {
                const match = path.match(/^\/git\/([^/]+)(\/.*)?$/);
                if (!match) throw new Error('Invalid repository path');
                // `/git/<id>/<name>.git/...`: the trailing name only gives git clients the repository's
                // folder name; the id alone selects the repository.
                const named = match[2]?.match(/^\/[^/]+\.git(\/.*)?$/);
                if (named) match[2] = named[1];
                const project = findRepository(
                  owner,
                  decodeURIComponent(match[1]).replace(/\.git$/, ''),
                );
                const lfs = match[2]?.startsWith('/info/lfs/');
                if (
                  lfsCredential &&
                  (!lfs || lfsCredential.owner !== owner || lfsCredential.projectId !== project.id)
                )
                  throw Object.assign(
                    new Error('This credential only reaches Git LFS for one repository'),
                    { status: 403 },
                  );
                if (workerIdentity) {
                  if (
                    !lfs &&
                    method !== 'GET' &&
                    !(method === 'POST' && match[2] === '/git-upload-pack')
                  )
                    throw Object.assign(new Error('Workers have read-only Git transport'), {
                      status: 403,
                    });
                  if (
                    url.searchParams.get('service') &&
                    url.searchParams.get('service') !== 'git-upload-pack'
                  )
                    throw Object.assign(new Error('Workers cannot push hosted repositories'), {
                      status: 403,
                    });
                  if (!workerMayReadRepository(owner, workerIdentity, project.id))
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
                    Boolean(workerIdentity) || lfsCredential?.operation === 'download',
                    {
                      user: owner,
                      actionHeader:
                        lfsCredential && typeof req.headers.authorization === 'string'
                          ? { Authorization: req.headers.authorization }
                          : undefined,
                    },
                  );
                serveRepositoryGit(req, res, project, match[2] || '/', url, owner);
                return;
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/ssh-keys',
          handler: async () => {
            try {
              return send({ keys: list('ssh-key', owner), server: sshServerInfo() });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/projects/:project/metadata',
          handler: async ({ params }) => {
            try {
              const project = get('project', owner, params.project);
              return send({
                id: project.id,
                name: project.name,
                description: project.description || '',
                settingsRevision: project.settingsRevision || 0,
              });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/projects/:project/storage',
          handler: async ({ params }) => {
            try {
              return send(await repositoryStorage(owner, params.project));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/projects/:project/storage/files',
          handler: async ({ params }) => {
            try {
              return send(
                await repositoryStorageFiles(owner, params.project, {
                  kind: url.searchParams.get('kind'),
                  sort: url.searchParams.get('sort') ?? undefined,
                  direction: url.searchParams.get('direction') ?? undefined,
                  query: url.searchParams.get('query') ?? undefined,
                  page: url.searchParams.get('page') ?? undefined,
                }),
              );
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/worker-permissions', '/computers/:computer/permissions'].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                const summary = computers(owner).map(
                  ({ id, name, platform, status, permissions, roles, computerId }) => ({
                    roles,
                    computerId,
                    id,
                    name,
                    platform,
                    status,
                    permissions,
                  }),
                );
                if (!params.computer) return send({ computers: summary });
                const computer = summary.find((candidate) => candidate.id === params.computer);
                return computer ? send(computer) : send({ error: 'Unknown computer' }, 404);
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/provider-connections',
          handler: async () => {
            try {
              return send({
                managed: managedWorkerStatus(owner),
                // Revoked computers keep their records for task history but are no longer computers.
                workers: list('worker', owner)
                  .filter((worker) => !worker.revokedAt)
                  .map((worker) => ({
                    ...worker,
                    providerStatus: worker.connections || [],
                    connections: providerConnections(owner, worker.id),
                    login:
                      list('provider-login', owner).find((login) => login.id === worker.id) || null,
                  })),
              });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/tasks/:task/controls', '/tasks/:task/controls/:control'].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                return send(
                  params.control
                    ? interactiveSnapshot(owner, params.task, params.control)
                    : interactiveRead(owner, params.task),
                );
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        ...['/projects/:project/pipelines', '/projects/:project/pipelines/:pipeline'].map(
          (pattern) =>
            route({
              method: 'GET',
              path: pattern,
              handler: async ({ params: matched }) => {
                const params = matched as Record<string, string>;
                try {
                  return send(pipelineRead(owner, params.project, params.pipeline));
                } catch (error: any) {
                  return respondError(error);
                }
              },
            }),
        ),
        ...[
          '/projects/:project/:kind(issues|pulls)',
          '/projects/:project/:kind(issues|pulls)/:item',
          '/projects/:project/:kind(issues|pulls)/:item/:action(diff|update|close|reopen|comments|merge|retry-merge|task|accept)',
        ].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                if (params.action && params.action !== 'diff')
                  return send({ error: 'Not found' }, 404);
                return send(
                  await collaborationRead(
                    owner,
                    params.project,
                    params.kind,
                    params.item,
                    params.action,
                    url.searchParams,
                  ),
                );
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/repositories/setup',
          handler: async () => {
            try {
              return send(await repositorySetup(owner));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/application-repositories',
          handler: async () => {
            try {
              const application = url.searchParams.get('application');
              if (!application) throw new Error('Application required');
              const projects = [];
              for (const project of list('project', owner)) {
                const repository = await repositoryInfo(owner, project.id, true);
                if ('deployment' in repository && repository.deployment.application === application)
                  projects.push({ id: project.id, name: project.name });
              }
              return send({ projects });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/projects/:project/repository/branches',
          handler: async ({ params }) => {
            try {
              return send(
                await repositoryBranches(owner, (params as Record<string, string>).project),
              );
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/projects/:project/repository/archive',
          handler: async ({ params }) => {
            try {
              await streamRepositoryArchive(
                owner,
                (params as Record<string, string>).project,
                url.searchParams.get('ref') || 'HEAD',
                res,
              );
              return;
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...[
          '/projects/:project/repository',
          '/projects/:project/repository/:action(tree|blob|history|diff|files|entry)',
        ].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                return send(
                  params.action
                    ? await repositoryRead(owner, params.project, params.action, url.searchParams)
                    : await repositoryInfo(owner, params.project, true),
                );
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/state',
          handler: async () => {
            try {
              return send(await readWorkspaceState(owner));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/events',
          handler: async () => {
            try {
              if (!url.searchParams.has('before')) return false;

              // Older history behind a task detail's bounded `events` (see `eventsBefore`).
              const before = Number(url.searchParams.get('before'));
              const limit = Number(url.searchParams.get('limit') || 200);
              const taskId = url.searchParams.get('taskId');
              if (!taskId || !Number.isSafeInteger(before) || before < 0)
                return send({ error: 'taskId and a before cursor are required' }, 400);
              if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
                return send({ error: 'limit must be 1–1000' }, 400);
              get('task', owner, taskId);
              const page = eventsBefore(owner, before, taskId, limit);
              return send({
                events: page,
                before: page.length === limit ? page[0].cursor : null,
              });
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/events',
          handler: async () => {
            try {
              const after = Number(url.searchParams.get('after') || 0);
              const waitMs = Number(url.searchParams.get('waitMs') || 0);
              if (
                !Number.isSafeInteger(after) ||
                after < 0 ||
                !Number.isFinite(waitMs) ||
                waitMs < 0
              )
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
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/tasks/:task/files', '/tasks/:task/files/:content(content)'].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                return send(
                  await taskFiles(owner, params.task, Boolean(params.content), url.searchParams),
                );
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        route({
          method: 'GET',
          path: '/tasks/:task/diff/:kind(file|patch)',
          handler: async ({ params }) => {
            try {
              const task = get('task', owner, params.task);
              const scope = url.searchParams.get('scope') === 'turn' ? 'turn' : 'all';
              return send(
                params.kind === 'file'
                  ? taskFilePatch(owner, task.id, url.searchParams.get('path') || '', scope)
                  : taskPatch(owner, task.id, scope),
              );
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        route({
          method: 'GET',
          path: '/tasks/:task/deletion',
          handler: async ({ params }) => {
            try {
              return send(taskDeletion(owner, params.task));
            } catch (error: any) {
              return respondError(error);
            }
          },
        }),
        ...['/tasks/:task', '/tasks/:task/:diff(diff)'].map((pattern) =>
          route({
            method: 'GET',
            path: pattern,
            handler: async ({ params: matched }) => {
              const params = matched as Record<string, string>;
              try {
                const task = get('task', owner, params.task);
                if (params.diff)
                  return send(
                    url.searchParams.get('scope') === 'turn'
                      ? turnDiff(owner, task.id)
                      : diff(owner, task.id),
                  );
                recoverShellCommands(owner, task.id);
                const runs = list('run', owner).filter((r) => r.taskId === task.id);
                const messages: Message[] = list('message', owner)
                  .filter((message) => message.taskId === task.id)
                  .map(cleanShellMessage);
                const recent = recentEvents(owner, task.id);
                const detail = {
                  task: {
                    ...taskQueue(owner, taskPullSummary(task, list('pull-request', owner))),
                    waitingForAnswer: tasksWaitingForAnswer(owner).has(task.id),
                    controlRequest: pendingControlRequests(owner).get(task.id) ?? null,
                  },
                  publishDefaults: taskPublishDefaults(owner, task),
                  latestCheckpoint: latestCheckpointSummary(owner, task.id),
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
                  runs: runs.map((run) => presentRun(owner, run)),
                  attachments: taskAttachments(owner, task.id),
                  queuedMessage: queuedMessage(owner, task.id),
                  questions: taskQuestions(owner, task.id),
                  jobs: list('job', owner)
                    .filter((r) => r.taskId === task.id)
                    .map((job) => jobSnapshot(describeJob(owner, job))),
                  events: recent.events,
                  // The snapshot keeps only the newest raw events; `eventsBefore` pages the rest
                  // via GET /events?taskId=…&before=….
                  eventsTruncated: recent.truncated,
                  eventsBefore: recent.before,
                  cursor: cursor(owner),
                };
                return send(detail satisfies TaskDetail);
              } catch (error: any) {
                return respondError(error);
              }
            },
          }),
        ),
        ...['', ':rest*'].map((pattern) =>
          route({
            method: 'POST',
            path: pattern,
            handler: postCommands,
          }),
        ),
      ],
      {
        ...options,
        notFound: async () => {
          try {
            await send({ error: 'Not found' }, 404);
          } catch (error: any) {
            return respondError(error);
          }
        },
      },
    )(req, res, undefined).then(() => undefined);
  } catch (error: any) {
    return respondError(error);
  }
}
