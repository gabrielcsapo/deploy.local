import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Computer,
  ComputerModels,
  ComputerRemoval,
  ModelDefaults,
  Role,
} from '../../shared/v2/contracts.ts';
import {
  createNodeEnrollment,
  getAllDeployments,
  getDeployments,
  getNodes,
  isAdmin,
  revokeNode,
} from '../store.ts';
import { computers as workspaceComputers } from '../workspace/coordination.ts';
import { db, list, save } from '../workspace/store.ts';
import { fail } from './inbox.ts';
import { setAutomaticUpdates } from './fleet-updates.ts';
import { getUpdates } from './updates.ts';

const roles: Role[] = ['coordinator', 'take-tasks', 'run-apps', 'serve-models', 'use-screen'];
const active = ['starting', 'running', 'unknown'];
function facts(value: any) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const finite = (value: any): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function mergeComputers(input: {
  nodes: any[];
  workers: any[];
  apps: any[];
  runs: any[];
  jobs: any[];
  tasks: any[];
  settings: any[];
}): Computer[] {
  const result: Computer[] = input.nodes
    .filter((n) => !n.revokedAt)
    .map((node) => {
      const info = facts(node.capabilities);
      const supportedRoles: Role[] = [
        ...(node.id === 'coordinator' ? ['coordinator' as const] : []),
        'run-apps',
        ...(Array.isArray(info.models) ? ['serve-models' as const] : []),
      ];
      return {
        id: node.id,
        nodeId: node.id,
        workerIds: [],
        name: node.name,
        online: node.online,
        platform: node.platform || undefined,
        architecture: node.architecture || undefined,
        version: node.agentVersion || undefined,
        roles: [...supportedRoles],
        supportedRoles,
        ...(finite(info.cpuPercent) && info.cpuPercent <= 100 ? { cpu: info.cpuPercent } : {}),
        ...(typeof info.cpuModel === 'string' ? { cpuModel: info.cpuModel } : {}),
        ...(finite(info.memoryBytes)
          ? {
              memory: {
                total: info.memoryBytes,
                ...(finite(info.memoryUsedBytes) ? { used: info.memoryUsedBytes } : {}),
              },
            }
          : {}),
        ...(finite(info.diskBytes)
          ? {
              disk: {
                total: info.diskBytes,
                ...(finite(info.diskUsedBytes) ? { used: info.diskUsedBytes } : {}),
              },
            }
          : {}),
        doing: input.apps
          .filter((app) => (app.activeNodeId || 'coordinator') === node.id)
          .map((app) => ({
            id: app.name,
            kind: 'app',
            name: app.name,
            state: app.status || 'Unavailable',
          })),
      };
    });
  for (const worker of input.workers) {
    // Local is authoritative. Remote links are written by the owner, never guessed from hostnames.
    const linked = input.settings.find((s) => s.workerIds.includes(worker.id));
    let computer = result.find(
      (c) => c.id === (worker.id === 'local' ? 'coordinator' : linked?.id),
    );
    if (!computer) {
      computer = {
        id: `worker:${worker.id}`,
        name: worker.name,
        online: worker.status === 'online',
        workerIds: [],
        roles: [],
        supportedRoles: [],
        platform: worker.platform,
        architecture: worker.architecture,
        version: worker.version,
        doing: [],
      };
      result.push(computer);
    }
    computer.workerIds.push(worker.id);
    computer.supportedRoles.push('take-tasks');
    computer.roles.push('take-tasks');
    if (worker.screenSupported) {
      computer.supportedRoles.push('use-screen');
      computer.roles.push('use-screen');
    }
    for (const [kind, rows] of [
      ['task', input.runs],
      ['job', input.jobs],
    ] as const)
      for (const row of rows.filter(
        (r) => (r.workerId || 'local') === worker.id && active.includes(r.status),
      ))
        computer.doing.push({
          id: row.id,
          kind,
          name:
            input.tasks.find((t) => t.id === row.taskId)?.title ||
            row.title ||
            row.taskId ||
            row.id,
          state: row.status,
        });
  }
  return result
    .filter((c) => !input.settings.find((s) => s.id === c.id)?.removed)
    .map((computer) => {
      const setting = input.settings.find((s) => s.id === computer.id);
      return {
        ...computer,
        supportedRoles: [...new Set(computer.supportedRoles)],
        roles: setting?.roles || [...new Set(computer.roles)],
      };
    });
}

export function getComputers(owner: string): Computer[] {
  return mergeComputers({
    nodes: getNodes(),
    workers: workspaceComputers(owner).filter(
      (worker) => worker.id !== 'local' || worker.heartbeat,
    ),
    apps: getDeployments(owner),
    runs: list('run', owner),
    jobs: list('job', owner),
    tasks: list('task', owner),
    settings: list('v2-computer-roles', owner),
  });
}
function computerFor(owner: string, id: string) {
  const computer = getComputers(owner).find((c) => c.id === id);
  if (!computer) fail('Computer not found', 404);
  return computer;
}
function admin(owner: string) {
  if (!isAdmin(owner)) fail('Administrator access is required to change computers', 403);
}
export function setComputerRoles(owner: string, id: string, value: unknown) {
  admin(owner);
  const computer = computerFor(owner, id);
  if (
    !Array.isArray(value) ||
    value.some((r) => !roles.includes(r)) ||
    new Set(value).size !== value.length
  )
    fail('Choose valid computer roles');
  if (value.some((r) => !computer.supportedRoles.includes(r)))
    fail('This computer does not support that role', 409);
  if (computer.roles.includes('coordinator') && !value.includes('coordinator'))
    fail('Coordinator is always on', 409);
  // Existing apps and model servers need explicit retirement; a role change must not stop them.
  for (const role of ['run-apps', 'serve-models'] as const)
    if (computer.roles.includes(role) !== value.includes(role))
      fail(
        `Changing ${role === 'run-apps' ? 'Run apps' : 'Serve models'} requires runtime reconfiguration on the computer`,
        409,
      );
  save('v2-computer-roles', owner, { id, roles: value, workerIds: computer.workerIds });
  return computerFor(owner, id);
}
export function removalPlan(owner: string, id: string): ComputerRemoval {
  admin(owner);
  const computers = getComputers(owner),
    computer = computerFor(owner, id);
  const destinations = computers
    .filter((c) => c.id !== id && c.online && c.roles.includes('run-apps'))
    .map(({ id, name }) => ({ id, name }));
  // Check every owner's apps before revoking a fleet-wide credential.
  const apps = getAllDeployments()
    .filter(
      (app) =>
        computer.nodeId &&
        ((app.activeNodeId || 'coordinator') === computer.nodeId ||
          app.desiredNodeId === computer.nodeId),
    )
    .map((app) => ({ id: app.name, name: app.name, destinations }));
  const tasks = [...list('run', owner), ...list('job', owner)]
    .filter(
      (row) =>
        computer.workerIds.includes(row.workerId || 'local') &&
        ['queued', ...active].includes(row.status),
    )
    .map((row) => ({
      id: row.id,
      name:
        list('task', owner).find((task) => task.id === row.taskId)?.title || row.taskId || row.id,
    }));
  const reasons = [
    ...(computer.roles.includes('coordinator') ? ['The coordinator cannot be removed.'] : []),
    ...(apps.length
      ? [
          destinations.length
            ? 'Move these apps and their data through their project releases before removing this computer.'
            : 'These apps need a new home. No other online computer can run apps.',
        ]
      : []),
    ...(tasks.length
      ? [
          'Finish or reassign the queued and active tasks and jobs first. They will not be interrupted.',
        ]
      : []),
    ...(computer.roles.includes('serve-models')
      ? ['Stop the model server on this computer first.']
      : []),
  ];
  return { computerId: id, allowed: !reasons.length, reasons, apps, tasks };
}
export function removeComputer(owner: string, id: string) {
  return db
    .transaction(() => {
      const plan = removalPlan(owner, id);
      if (!plan.allowed) fail(plan.reasons.join(' '), 409);
      const computer = computerFor(owner, id);
      for (const workerId of computer.workerIds) {
        db.prepare("DELETE FROM records WHERE kind='worker-credential' AND owner=? AND id=?").run(
          owner,
          workerId,
        );
        db.prepare("DELETE FROM records WHERE kind='worker' AND owner=? AND id=?").run(
          owner,
          workerId,
        );
      }
      if (computer.nodeId) revokeNode(computer.nodeId);
      save('v2-computer-roles', owner, {
        id,
        workerIds: computer.workerIds,
        roles: [],
        removed: true,
      });
      return { removed: true };
    })
    .immediate();
}

export function getModels(owner: string): ComputerModels {
  const workers = workspaceComputers(owner),
    computers = getComputers(owner);
  const choices: ComputerModels['choices'] = [];
  for (const worker of workers)
    for (const option of Array.isArray(worker.modelOptions) ? worker.modelOptions : [])
      for (const model of Array.isArray(option?.models) ? option.models : [])
        if (
          ['claude', 'codex', 'compatible'].includes(option.id) &&
          typeof model?.id === 'string' &&
          typeof model?.name === 'string' &&
          !choices.some((c) => c.id === `${option.id}:${model.id}`)
        )
          choices.push({
            id: `${option.id}:${model.id}`,
            name: model.name,
            provider: option.id,
            model: model.id,
          });
  const local: ComputerModels['local'] = [];
  for (const node of getNodes()) {
    if (!computers.some((c) => c.nodeId === node.id && c.roles.includes('serve-models'))) continue;
    const inventory = facts(node.capabilities).models;
    for (const model of Array.isArray(inventory) ? inventory : []) {
      if (typeof model?.id !== 'string' || typeof model?.name !== 'string') continue;
      local.push({
        id: model.id,
        name: model.name,
        computer: node.name,
        loaded: model.loaded === true,
      });
      if (!choices.some((c) => c.id === `compatible:${model.id}`))
        choices.push({
          id: `compatible:${model.id}`,
          name: model.name,
          provider: 'compatible',
          model: model.id,
        });
    }
  }
  return {
    choices,
    local,
    defaults: list('v2-model-defaults', owner)[0]?.defaults || {
      'writing-code': null,
      reviewing: null,
      'answering-questions': null,
    },
    providers: ['claude', 'codex'].map((id) => {
      const reports = workers.flatMap((w) =>
        (w.providers || [])
          .filter((p: any) => p.id === id)
          .map((p: any) => ({ ...p, computer: w.name })),
      );
      const weekly = reports
        .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0))
        .find((p) => p.windows?.some((w: any) => /weekly/i.test(w.label)));
      const window = weekly?.windows.find((w: any) => /weekly/i.test(w.label));
      return {
        id,
        name: id === 'claude' ? 'Claude' : 'Codex',
        computers: reports.filter((p) => p.status === 'signed-in').map((p) => p.computer),
        ...(window
          ? {
              weekly: {
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt,
                checkedAt: weekly.checkedAt,
              },
            }
          : {}),
      };
    }),
  };
}
export function setModelDefaults(owner: string, value: ModelDefaults) {
  const models = getModels(owner),
    keys = ['writing-code', 'reviewing', 'answering-questions'];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 3 ||
    keys.some((key) => !(key in value)) ||
    Object.values(value).some((id) => id !== null && !models.choices.some((c) => c.id === id))
  )
    fail('Choose an available model for each job');
  save('v2-model-defaults', owner, { id: 'defaults', defaults: value });
  return getModels(owner);
}
async function body(req: IncomingMessage) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 16384) {
      req.resume();
      fail('Request too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail('Invalid JSON');
  }
}
export async function computersApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname.slice('/api/v2'.length);
  if (path !== '/updates' && path !== '/computers' && !path.startsWith('/computers/')) return false;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  if (path === '/updates' && req.method === 'GET')
    return send(getUpdates(owner, getComputers(owner)));
  if (path === '/updates' && req.method === 'PUT') {
    setAutomaticUpdates(owner, (await body(req)).automatic);
    return send(getUpdates(owner, getComputers(owner)));
  }
  if (path === '/computers' && req.method === 'GET')
    return send({ computers: getComputers(owner) });
  if (path === '/computers/models') {
    if (req.method === 'GET') return send(getModels(owner));
    if (req.method === 'PUT') return send(setModelDefaults(owner, (await body(req)).defaults));
  }
  if (path === '/computers/enrollment' && req.method === 'POST') {
    admin(owner);
    const input = await body(req);
    if (typeof input.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,99}$/.test(input.name))
      fail('Enter a computer name (letters, numbers, spaces, dots or dashes)');
    return send(createNodeEnrollment(input.name, owner), 201);
  }
  const match = path.match(/^\/computers\/([^/]+)(\/removal)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (req.method === 'GET')
      return send(match[2] ? removalPlan(owner, id) : { computer: computerFor(owner, id) });
    if (!match[2] && req.method === 'PATCH')
      return send({ computer: setComputerRoles(owner, id, (await body(req)).roles) });
    if (!match[2] && req.method === 'DELETE') return send(removeComputer(owner, id));
  }
  return send({ error: 'Method not allowed' }, 405);
}
