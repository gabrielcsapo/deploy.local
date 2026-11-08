import { agentBuildInstallConfig } from '../packages/builds.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import {
  error,
  json,
  reportMigrationProgress,
  agentJobsWithStreamedBuildOutput,
  requireAdmin,
} from './shared.ts';
import {
  redeemNodeEnrollment,
  authenticateNode,
  deployRoleEnabled,
  getAgentRoles,
  heartbeatNode,
  reconcileNodeRuntimePorts,
  claimAgentJob,
  getAgentJob,
  completeAgentJob,
  buildLogFilePath,
  saveBackup,
  getFleetPlacementState,
  getRecentAgentJobs,
  createNodeEnrollment,
  setDefaultNode,
  revokeNode,
} from '../store.ts';
import { parseWantedRoles } from '../computer-roles.ts';
import { enrollWorker } from '../workspace/credentials.ts';
import { deploymentNotifications } from '../deployment-notification-service.ts';
import { isIP } from 'node:net';
import { reportComputerUpdate, rejectComputerUpdateJob } from '../v2/fleet-updates.ts';
import {
  claimAgentExecSession,
  pollAgentExecSession,
  writeAgentExecOutput,
  closeAgentExecSession,
} from '../agent-exec.ts';
import { existsSync, statSync, createReadStream, appendFileSync, createWriteStream } from 'node:fs';
import { emit } from '../events.ts';
import { getBackupDir } from '../volumes.ts';
import { resolve } from 'node:path';
import { rename, rm } from 'node:fs/promises';
import { getDeploymentContainerStatuses } from '../docker.ts';
import { coordinatorDockerReachable } from '../metrics-collector.ts';
import { allComputerRoles } from '../workspace/coordination.ts';
import { patchComputerRoles } from '../computer-roles-api.ts';
import { type IncomingMessage } from 'node:http';
import { type ApiRouteContext } from './context.ts';
import { handleRemoteTelemetry, issueRemoteTelemetryToken } from '../telemetry-remote.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { readDeploymentRecord } from '../store.ts';

interface AgentJobActivity {
  stage: string;
  processedBytes: number;
  totalBytes: number;
  updatedAt: number;
  logs: Array<{ timestamp: number; message: string }>;
}

const agentActivityByJob = new Map<string, AgentJobActivity>();

function updateAgentActivity(
  jobId: string,
  update: Partial<Omit<AgentJobActivity, 'logs'>>,
  message?: string,
) {
  const current = agentActivityByJob.get(jobId) || {
    stage: 'queued',
    processedBytes: 0,
    totalBytes: 0,
    updatedAt: Date.now(),
    logs: [],
  };
  const logs = message
    ? [...current.logs, { timestamp: Date.now(), message }].slice(-20)
    : current.logs;
  agentActivityByJob.set(jobId, {
    ...current,
    ...update,
    updatedAt: Date.now(),
    logs,
  });
}

function remoteAddress(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress?.replace(/^::ffff:/, '');
}

export async function fleetRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Fleet enrollment and node administration ───────────────────────

      if (path === '/api/agent/telemetry/v1/server' && method === 'POST') {
        await handleRemoteTelemetry(req, res);
        return;
      }

      if (path === '/api/agent/enroll' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.code) return error(res, 'Enrollment code required');
        const result = redeemNodeEnrollment({
          roles: body.roles === undefined ? undefined : parseWantedRoles(body.roles),
          code: String(body.code),
          name: typeof body.name === 'string' ? body.name : undefined,
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          architecture: typeof body.architecture === 'string' ? body.architecture : undefined,
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : undefined,
          address: remoteAddress(req),
          capabilities:
            body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : undefined,
        });
        if ('error' in result && result.error) return error(res, result.error, 400);
        const { enrollmentOwner, ...credential } = result;
        const worker =
          (result.roles?.tasks || body.taskWorker === true) && enrollmentOwner
            ? enrollWorker(enrollmentOwner, { workerId: `node-worker-${result.nodeId}` })
            : {};
        return json(res, { ...credential, ...worker }, 201);
      }

      if (path === '/api/agent/events' && method === 'GET') {
        return deploymentNotifications.stream(req, res, authenticateNode, deployRoleEnabled);
      }

      if (path === '/api/agent/status' && method === 'GET') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        return json(res, { roles: getAgentRoles(nodeId!) });
      }

      if (path === '/api/agent/heartbeat' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const advertisedAddress =
          typeof body.address === 'string' && isIP(body.address) === 4
            ? body.address
            : remoteAddress(req);
        const node = heartbeatNode(nodeId!, {
          platform: typeof body.platform === 'string' ? body.platform : undefined,
          architecture: typeof body.architecture === 'string' ? body.architecture : undefined,
          agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : undefined,
          address: advertisedAddress,
          capabilities:
            body.capabilities && typeof body.capabilities === 'object'
              ? body.capabilities
              : undefined,
        });
        reportComputerUpdate(
          nodeId!,
          body.updateReport,
          typeof body.agentVersion === 'string' ? body.agentVersion : undefined,
        );
        if (Array.isArray(body.capabilities?.apps)) {
          reconcileNodeRuntimePorts(nodeId!, body.capabilities.apps);
        }
        return json(res, { ok: true, node });
      }

      if (path === '/api/agent/jobs/claim' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = claimAgentJob(nodeId!);
        if (!job) {
          res.writeHead(204);
          res.end();
          return;
        }
        updateAgentActivity(
          job.id,
          { stage: 'starting' },
          `Started ${job.type} for ${job.deploymentName}`,
        );
        // Sent only over this computer-authenticated channel. Bind the deployment credential
        // to both this computer and the current owner so it cannot be used across tenants.
        let telemetryToken: string | undefined;
        if (['deploy', 'recreate', 'project-release'].includes(job.type)) {
          const app = readDeploymentRecord(job.deploymentName);
          if (app)
            try {
              telemetryToken = issueRemoteTelemetryToken(
                getRequestsSqlite(),
                app.name,
                nodeId!,
                app.username,
              );
            } catch (cause) {
              console.warn('[telemetry] token unavailable:', cause);
            }
        }
        return json(res, {
          id: job.id,
          type: job.type,
          deploymentName: job.deploymentName,
          payload: JSON.parse(job.payload),
          telemetryToken,
          artifactUrl: job.artifactPath ? `/api/agent/jobs/${job.id}/artifact` : null,
        });
      }

      if (path === '/api/agent/exec/claim' && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const session = claimAgentExecSession(nodeId!);
        if (!session) {
          res.writeHead(204);
          res.end();
          return;
        }
        return json(res, session);
      }

      const agentExecPollMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/poll$/);

      if (agentExecPollMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const control = pollAgentExecSession(agentExecPollMatch[1], nodeId!);
        if (!control) return error(res, 'Terminal session not found', 404);
        return json(res, control);
      }

      const agentExecOutputMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/output$/);

      if (agentExecOutputMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (
          !writeAgentExecOutput(
            agentExecOutputMatch[1],
            nodeId!,
            typeof body.output === 'string' ? body.output : '',
          )
        ) {
          return error(res, 'Terminal session not found', 404);
        }
        return json(res, { ok: true });
      }

      const agentExecExitMatch = path.match(/^\/api\/agent\/exec\/([^/]+)\/exit$/);

      if (agentExecExitMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        closeAgentExecSession(agentExecExitMatch[1], nodeId!, {
          code: Number.isInteger(body.code) ? body.code : null,
          error: typeof body.error === 'string' ? body.error : undefined,
        });
        return json(res, { ok: true });
      }

      const packagesMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/packages$/);
      if (packagesMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const config = await agentBuildInstallConfig(nodeId!, packagesMatch[1]);
        if (!config) return error(res, 'Build assignment not available', 403);
        res.setHeader('Cache-Control', 'no-store');
        return json(res, config);
      }

      const agentJobArtifactMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/artifact$/);

      if (agentJobArtifactMatch && method === 'GET') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobArtifactMatch[1]);
        if (!job || job.nodeId !== nodeId || !job.artifactPath || !existsSync(job.artifactPath)) {
          return error(res, 'Artifact not found', 404);
        }
        const stat = statSync(job.artifactPath);
        const rangeHeader = req.headers.range;
        const rangeMatch =
          typeof rangeHeader === 'string' ? rangeHeader.match(/^bytes=(\d+)-$/) : null;
        const startByte = rangeMatch ? Number(rangeMatch[1]) : 0;
        if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= stat.size) {
          res.writeHead(416, {
            'Content-Range': `bytes */${stat.size}`,
            'Accept-Ranges': 'bytes',
          });
          res.end();
          return;
        }
        const partial = startByte > 0;
        res.writeHead(partial ? 206 : 200, {
          'Content-Type': 'application/gzip',
          'Content-Length': stat.size - startByte,
          'Accept-Ranges': 'bytes',
          ...(partial
            ? { 'Content-Range': `bytes ${startByte}-${stat.size - 1}/${stat.size}` }
            : {}),
        });
        const artifactStream = createReadStream(job.artifactPath, { start: startByte });
        if (job.type === 'restore') {
          let processedBytes = startByte;
          let lastReportedAt = 0;
          const report = (force = false) => {
            const now = Date.now();
            if (!force && now - lastReportedAt < 500) return;
            lastReportedAt = now;
            reportMigrationProgress(job.deploymentName, {
              phase: 'restoring',
              stage: 'transferring',
              processedBytes,
              totalBytes: stat.size,
            });
            updateAgentActivity(job.id, {
              stage: 'downloading backup',
              processedBytes,
              totalBytes: stat.size,
            });
          };
          artifactStream.on('data', (chunk) => {
            processedBytes += chunk.length;
            report();
          });
          artifactStream.on('end', () => {
            report(true);
            reportMigrationProgress(job.deploymentName, {
              phase: 'restoring',
              stage: 'extracting',
              processedBytes: stat.size,
              totalBytes: stat.size,
            });
            updateAgentActivity(
              job.id,
              {
                stage: 'extracting backup',
                processedBytes: 0,
                totalBytes: stat.size,
              },
              'Backup download complete; extracting archive',
            );
          });
        } else if (job.type === 'deploy') {
          let processedBytes = startByte;
          let lastReportedAt = 0;
          const report = (force = false) => {
            const now = Date.now();
            if (!force && now - lastReportedAt < 500) return;
            lastReportedAt = now;
            updateAgentActivity(job.id, {
              stage: 'downloading source',
              processedBytes,
              totalBytes: stat.size,
            });
          };
          artifactStream.on('data', (chunk) => {
            processedBytes += chunk.length;
            report();
          });
          artifactStream.on('end', () => {
            report(true);
            updateAgentActivity(
              job.id,
              {
                stage: 'unpacking source',
                processedBytes: stat.size,
                totalBytes: stat.size,
              },
              'Source download complete; unpacking application',
            );
          });
        }
        artifactStream.pipe(res);
        return;
      }

      const agentJobCompleteMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/complete$/);

      if (agentJobCompleteMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const body = JSON.parse((await readBody(req)).toString());
        try {
          if (getAgentJob(agentJobCompleteMatch[1])?.type === 'self-update') {
            if (body.success === true)
              return error(res, 'A post-restart version report is required', 409);
            rejectComputerUpdateJob(
              agentJobCompleteMatch[1],
              nodeId!,
              String(body.error || 'Update could not start'),
            );
            return json(res, { ok: true });
          }
          completeAgentJob(agentJobCompleteMatch[1], nodeId!, {
            success: body.success === true,
            result: body.result && typeof body.result === 'object' ? body.result : undefined,
            error: typeof body.error === 'string' ? body.error : undefined,
          });
          updateAgentActivity(
            agentJobCompleteMatch[1],
            { stage: body.success === true ? 'complete' : 'failed' },
            body.success === true
              ? 'Job completed'
              : `Job failed: ${typeof body.error === 'string' ? body.error : 'unknown error'}`,
          );
          return json(res, { ok: true });
        } catch (err) {
          return error(res, (err as Error).message, 404);
        }
      }

      const agentJobProgressMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/progress$/);

      if (agentJobProgressMatch && method === 'POST') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobProgressMatch[1]);
        if (!job || job.nodeId !== nodeId) return error(res, 'Job not found', 404);
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const processedBytes = Math.max(0, Number(body.processedBytes || 0));
        const totalBytes = Math.max(0, Number(body.totalBytes || 0));
        const stage = String(body.stage || 'working').slice(0, 80);
        updateAgentActivity(
          job.id,
          { stage, processedBytes, totalBytes },
          typeof body.message === 'string' ? body.message.slice(0, 500) : undefined,
        );
        const buildOutput =
          job.type === 'deploy' && typeof body.output === 'string'
            ? body.output.slice(0, 512 * 1024)
            : '';
        if (buildOutput) {
          const payload = JSON.parse(job.payload) as { buildLogId?: number };
          const buildLogId = Number(payload.buildLogId);
          if (Number.isSafeInteger(buildLogId) && buildLogId > 0) {
            appendFileSync(buildLogFilePath(buildLogId), buildOutput);
            agentJobsWithStreamedBuildOutput.add(job.id);
            for (const outputLine of buildOutput.split('\n')) {
              if (!outputLine) continue;
              const timestampedLine = outputLine.match(/^\[([^\]]+)]\s?(.*)$/);
              emit({
                type: 'build:output',
                deploymentName: job.deploymentName,
                data: {
                  line: timestampedLine?.[2] ?? outputLine,
                  timestamp: timestampedLine?.[1] ?? new Date().toISOString(),
                },
              });
            }
          }
        }
        if (job.type === 'restore') {
          reportMigrationProgress(job.deploymentName, {
            phase: 'restoring',
            stage: 'extracting',
            processedBytes,
            totalBytes,
          });
        }
        return json(res, { ok: true });
      }

      const agentJobBackupMatch = path.match(/^\/api\/agent\/jobs\/([^/]+)\/backup$/);

      if (agentJobBackupMatch && method === 'PUT') {
        const nodeId = req.headers['x-deploy-node-id'] as string | undefined;
        const secret = req.headers['x-deploy-node-secret'] as string | undefined;
        if (!authenticateNode(nodeId, secret)) return error(res, 'Invalid node credential', 401);
        const job = getAgentJob(agentJobBackupMatch[1]);
        if (!job || job.nodeId !== nodeId || job.type !== 'backup') {
          return error(res, 'Backup job not found', 404);
        }
        const payload = JSON.parse(job.payload) as {
          label?: string;
          createdBy?: string;
          relatedBuildLogId?: number | null;
          auto?: boolean;
        };
        const timestamp = new Date().toISOString();
        const safeTimestamp = timestamp.replace(/[:.]/g, '-');
        const label = String(payload.label || 'scheduled').replace(/[^a-zA-Z0-9-]/g, '_');
        const filename = `${safeTimestamp}-${label}.tar.gz`;
        const backupDir = getBackupDir(job.deploymentName);
        const temporaryPath = resolve(backupDir, `.${job.id}.partial`);
        const finalPath = resolve(backupDir, filename);
        try {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            const output = createWriteStream(temporaryPath, { flags: 'wx' });
            const totalBytes = Number(req.headers['content-length'] || 0);
            let processedBytes = 0;
            let lastReportedAt = 0;
            req.on('data', (chunk: Buffer) => {
              processedBytes += chunk.length;
              const now = Date.now();
              if (now - lastReportedAt < 500 && processedBytes !== totalBytes) return;
              lastReportedAt = now;
              reportMigrationProgress(job.deploymentName, {
                phase: 'backing-up',
                stage: 'transferring',
                processedBytes,
                totalBytes,
              });
              updateAgentActivity(job.id, {
                stage: 'uploading backup',
                processedBytes,
                totalBytes,
              });
            });
            req.pipe(output);
            output.on('finish', resolvePromise);
            output.on('error', rejectPromise);
            req.on('error', rejectPromise);
          });
          await rename(temporaryPath, finalPath);
          const sizeBytes = statSync(finalPath).size;
          saveBackup({
            deploymentName: job.deploymentName,
            filename,
            label,
            sizeBytes,
            createdBy: payload.createdBy || 'agent',
            createdAt: timestamp,
            volumePaths: ['data', 'uploads'],
            relatedBuildLogId: payload.relatedBuildLogId ?? null,
            auto: payload.auto === true,
          });
          return json(res, { filename, sizeBytes, timestamp, volumePaths: ['data', 'uploads'] });
        } catch (err) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          return error(res, `Backup upload failed: ${(err as Error).message}`, 500);
        }
      }

      if (path === '/api/nodes' && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const fleet = getFleetPlacementState();
        const coordinatorApps = await getDeploymentContainerStatuses();
        return json(res, {
          ...fleet,
          nodes: fleet.nodes.map((entry) => {
            const node = { ...entry, deployEnabled: deployRoleEnabled(entry.id) };
            if (node.kind === 'coordinator') {
              // The stored coordinator row claims Docker unconditionally; report the probe instead.
              const reachable = coordinatorDockerReachable();
              return {
                ...node,
                apps: coordinatorApps,
                capabilities: JSON.stringify({
                  ...JSON.parse(node.capabilities || '{}'),
                  docker: reachable === true,
                  ...(reachable === true
                    ? {}
                    : {
                        dockerError:
                          reachable === null
                            ? 'Docker reachability has not been checked yet.'
                            : 'Docker is not reachable from the coordinator. Check the daemon and service permissions.',
                      }),
                }),
              };
            }
            try {
              const capabilities = JSON.parse(node.capabilities || '{}') as {
                apps?: unknown[];
              };
              return {
                ...node,
                apps: Array.isArray(capabilities.apps) ? capabilities.apps : [],
                jobs: getRecentAgentJobs(node.id).map((job) => ({
                  id: job.id,
                  type: job.type,
                  deploymentName: job.deploymentName,
                  status: job.status,
                  createdAt: job.createdAt,
                  claimedAt: job.claimedAt,
                  completedAt: job.completedAt,
                  error: job.error,
                  activity: agentActivityByJob.get(job.id) || null,
                })),
              };
            } catch {
              return {
                ...node,
                apps: [],
                jobs: getRecentAgentJobs(node.id).map((job) => ({
                  id: job.id,
                  type: job.type,
                  deploymentName: job.deploymentName,
                  status: job.status,
                  createdAt: job.createdAt,
                  claimedAt: job.claimedAt,
                  completedAt: job.completedAt,
                  error: job.error,
                  activity: agentActivityByJob.get(job.id) || null,
                })),
              };
            }
          }),
        });
      }

      if (path === '/api/computers' && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        return json(res, { computers: allComputerRoles(auth.username) });
      }

      const rolesMatch = path.match(/^\/api\/computers\/([^/]+)\/roles$/);

      if (rolesMatch && method === 'PATCH') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        try {
          return json(
            res,
            patchComputerRoles(
              auth.username,
              decodeURIComponent(rolesMatch[1]),
              JSON.parse((await readBody(req)).toString()),
            ),
          );
        } catch (err) {
          return error(res, (err as Error).message, (err as any).status || 400);
        }
      }

      if (path === '/api/nodes/enrollment' && method === 'POST') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        try {
          return json(
            res,
            createNodeEnrollment(
              String(body.name || ''),
              auth.username,
              body.roles === undefined ? undefined : parseWantedRoles(body.roles),
            ),
            201,
          );
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      if (path === '/api/nodes/default' && method === 'PUT') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        try {
          return json(res, { node: setDefaultNode(String(body.nodeId || '')) });
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }

      const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);

      if (nodeMatch && method === 'DELETE') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        try {
          revokeNode(decodeURIComponent(nodeMatch[1]));
          return json(res, { message: 'Node access revoked' });
        } catch (err) {
          return error(res, (err as Error).message);
        }
      }
      return false;
    } catch (err: unknown) {
      console.error(err);
      error(
        res,
        (err as Error).message || 'Internal server error',
        err instanceof RequestBodyTooLargeError
          ? 413
          : (err as Error & { status?: number }).status || 500,
      );
    }
  })();
  return result !== false;
}
