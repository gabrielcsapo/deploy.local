import { parseNodeCapabilities } from './node-permissions.ts';
import { createAttachment } from './attachments.ts';
import { createHash } from 'node:crypto';
import { db, get, list, save, event, id, now, command } from './store.ts';
import type { AgentScope } from './coordination.ts';

const lifetime = 30 * 60 * 1000;
const lease = 8000;
const live = (session: any) => !['stopped', 'suspended'].includes(session.status);
const fail = (message: string) => {
  throw Object.assign(new Error(message), { status: 409 });
};
function scoped(owner: string, taskId: string, sessionId: string) {
  const session = get('interactive-session', owner, sessionId);
  if (session.taskId !== taskId)
    throw Object.assign(new Error('Session belongs to another task'), { status: 403 });
  return session;
}
function update(owner: string, session: any, patch: any) {
  const next = save('interactive-session', owner, { ...session, ...patch, updatedAt: now() });
  event(owner, session.taskId, null, 'control.' + next.status, {
    sessionId: session.id,
    workerId: session.workerId,
    kind: session.kind,
    controlOwner: next.controlOwner,
    reason: next.reason,
  });
  return next;
}
function invalidate(owner: string, session: any, status: string, reason: string) {
  for (const entry of list('interactive-command', owner).filter(
    (c) => c.sessionId === session.id && ['queued', 'running'].includes(c.status),
  ))
    save('interactive-command', owner, {
      ...entry,
      status: entry.status === 'queued' ? 'cancelled' : 'unknown',
      error: reason,
    });
  return update(owner, session, { status, reason, generation: id(), controlOwner: null });
}
function screenLockStatus(lock: any) {
  if (!lock || typeof lock !== 'object') return { locks: null, idleSeconds: null };
  return {
    locks: typeof lock.locks === 'boolean' ? lock.locks : null,
    idleSeconds:
      Number.isFinite(lock.idleSeconds) && lock.idleSeconds > 0
        ? Math.min(Math.round(lock.idleSeconds), 86400 * 7)
        : null,
    changedByDeploy: lock.changedByDeploy === true,
  };
}
/** Ends a worker's live control sessions, e.g. when its access is revoked. */
export function suspendWorkerSessions(owner: string, workerId: string, reason: string) {
  for (const session of list('interactive-session', owner).filter(
    (s) => s.workerId === workerId && live(s),
  ))
    invalidate(owner, session, 'suspended', reason);
}
function reconcile(owner: string) {
  for (const session of list('interactive-session', owner).filter(live)) {
    if (
      Date.now() > session.expiresAt ||
      Date.now() - Date.parse(session.heartbeat || session.createdAt) > lease
    )
      invalidate(
        owner,
        session,
        'suspended',
        'Control connection expired. Inspect the target and start a new session; previous input will not be replayed.',
      );
  }
}
/**
 * The access request each task is waiting on, if any: pending, unexpired, and from a run that
 * is still going. Clients show it inline (Allow / Not now) and mark the task as needing you.
 */
export function pendingControlRequests(owner: string) {
  const runs = new Map(list('run', owner).map((run) => [run.id, run]));
  const pending = new Map<string, Record<string, any>>();
  for (const request of list('interactive-request', owner)) {
    const run = runs.get(request.runId);
    if (
      request.status !== 'pending' ||
      request.expiresAt < Date.now() ||
      !run ||
      run.stopRequested ||
      !['starting', 'running'].includes(run.status)
    )
      continue;
    let worker = request.workerId;
    try {
      worker = get('worker', owner, request.workerId).name || worker;
    } catch {
      /* Keep the recorded identity. */
    }
    pending.set(request.taskId, {
      id: request.id,
      kind: request.kind,
      targetLabel: request.targetLabel,
      workerName: worker,
      record: request.record === true,
      viewOnly: request.viewOnly === true,
      desktopInput: request.desktopInput === true,
      targetReason: request.targetReason,
      expiresAt: request.expiresAt,
    });
  }
  return pending;
}
export function interactiveRead(owner: string, taskId: string) {
  get('task', owner, taskId);
  reconcile(owner);
  return {
    requests: list('interactive-request', owner)
      .filter((r) => r.taskId === taskId)
      .map((r) => {
        if (r.status !== 'pending') return r;
        const run = list('run', owner).find((entry) => entry.id === r.runId);
        const cancelled =
          !run || run.stopRequested || !['starting', 'running'].includes(run.status);
        return {
          ...r,
          status: cancelled ? 'cancelled' : r.expiresAt < Date.now() ? 'expired' : r.status,
        };
      }),
    targets: list('interactive-worker', owner).flatMap((worker) =>
      worker.targets.map((target: any) => ({
        ...target,
        workerId: worker.id,
        available: target.available && Date.now() - Date.parse(worker.heartbeat) < lease,
      })),
    ),
    sessions: list('interactive-session', owner).filter((s) => s.taskId === taskId),
    commands: list('interactive-command', owner)
      .filter((c) => c.taskId === taskId)
      .slice(-30)
      .map(({ args: _, ...c }) => c),
  };
}
export function interactiveSnapshot(owner: string, taskId: string, sessionId: string) {
  scoped(owner, taskId, sessionId);
  return list('interactive-snapshot', owner).find((s) => s.id === sessionId) || null;
}
function validAction(kind: string, action: any) {
  if (!action || typeof action !== 'object' || Array.isArray(action))
    throw new Error('Action required');
  if (!['inspect', 'navigate', 'click', 'fill', 'text', 'press', 'scroll'].includes(action.type))
    throw new Error('Unsupported control action');
  if (JSON.stringify(action).length > 12000) throw new Error('Control action too large');
  if (action.type === 'navigate') {
    const url = new URL(action.url);
    if (
      kind !== 'browser' ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Use an HTTP(S) URL without credentials');
  }
  if (
    ['click', 'fill'].includes(action.type) &&
    kind === 'browser' &&
    !(
      action.type === 'click' &&
      Number.isFinite(action.x) &&
      Number.isFinite(action.y) &&
      action.x >= 0 &&
      action.x < 1280 &&
      action.y >= 0 &&
      action.y < 800
    ) &&
    (typeof action.selector !== 'string' || !action.selector || action.selector.length > 1000)
  )
    throw new Error('A specific selector from the inspected page is required');
  if (
    ['fill', 'text'].includes(action.type) &&
    (typeof action.text !== 'string' || action.text.length > 8000)
  )
    throw new Error('Text must be at most 8000 characters');
  if (action.type === 'press' && (typeof action.key !== 'string' || action.key.length > 80))
    throw new Error('Key required');
  if (kind === 'computer' && ['navigate', 'fill'].includes(action.type))
    throw new Error('Desktop supports inspect, click, press and scroll');
  if ((kind === 'computer' && action.type === 'click') || action.type === 'scroll') {
    if (![action.x, action.y].every((value) => Number.isFinite(value) && Math.abs(value) <= 10000))
      throw new Error('Finite coordinates required');
  }
  return action;
}
function enqueue(owner: string, session: any, body: any, controller: string, runId: string | null) {
  if (session.status !== 'active' || session.controlOwner !== controller)
    fail('Take control of this session before sending input');
  if (session.generation !== body.generation) fail('Control changed; refresh before interacting');
  if (session.viewOnly && body.action?.type !== 'inspect')
    fail('This desktop is view-only; only inspect is supported');
  if (
    session.kind === 'computer' &&
    body.action?.type !== 'inspect' &&
    !interactiveSnapshot(owner, session.taskId, session.id)
  )
    fail(
      'Inspect this session first with input: {type: "inspect"}, then read its snapshot before acting. No input was queued.',
    );
  if (
    list('interactive-command', owner).some(
      (c) => c.sessionId === session.id && ['queued', 'running'].includes(c.status),
    )
  )
    fail('Wait for the current interaction to finish');
  const entry = save('interactive-command', owner, {
    id: id(),
    taskId: session.taskId,
    sessionId: session.id,
    generation: session.generation,
    runId,
    controller,
    args: validAction(session.kind, body.action),
    status: 'queued',
    createdAt: now(),
  });
  event(owner, session.taskId, runId, 'control.queued', {
    sessionId: session.id,
    commandId: entry.id,
    action: entry.args.type,
    controller,
  });
  return entry;
}
export function interactiveOperator(owner: string, taskId: string, action: string, body: any) {
  get('task', owner, taskId);
  reconcile(owner);
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, action, body }))
    .digest('hex');
  return command(
    owner,
    body.operationId,
    () => {
      if (typeof body.clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(body.clientId))
        throw new Error('Client identity required');
      const controller = 'user:' + body.clientId;
      let request: any;
      if (['approve', 'deny'].includes(action)) {
        request = get('interactive-request', owner, body.requestId);
        if (request.taskId !== taskId) fail('Request belongs to another task');
        if (request.status !== 'pending' || request.expiresAt < Date.now())
          fail('Request is no longer pending');
        if (action === 'deny') {
          const denied = save('interactive-request', owner, { ...request, status: 'denied' });
          event(owner, taskId, request.runId, 'control.denied', { requestId: request.id });
          return denied;
        }
        const run = get('run', owner, request.runId);
        if (!['starting', 'running'].includes(run.status) || run.stopRequested)
          fail('Requesting run has ended or was stopped; access was not granted');
        // Approval binds the exact target and worker process the agent requested.
        body = {
          ...body,
          workerId: request.workerId,
          targetId: request.targetId,
          record: request.record,
        };
      }
      if (action === 'open' || action === 'approve') {
        const worker = get('interactive-worker', owner, body.workerId);
        if (request && worker.instanceId !== request.instanceId)
          fail('Worker changed; request access again');
        const target = worker.targets.find((t: any) => t.id === body.targetId && t.available);
        if (!target || Date.now() - Date.parse(worker.heartbeat) > lease)
          fail('This control target is unavailable');
        if ((target.viewOnly || target.desktopStatus) && body.record === true)
          fail('Linux desktop capture supports snapshots only');
        if (
          target.kind === 'computer' &&
          (
            db.prepare("SELECT data FROM records WHERE kind='interactive-session'").all() as {
              data: string;
            }[]
          )
            .map((row) => JSON.parse(row.data))
            .some(
              (s) =>
                live(s) &&
                s.kind === 'computer' &&
                (worker.id === 'local'
                  ? s.workerId === 'local'
                  : s.instanceId === worker.instanceId) &&
                s.expiresAt > Date.now() &&
                Date.now() - Date.parse(s.heartbeat || s.createdAt) < lease,
            )
        )
          fail('This desktop already has a control session');
        if (list('interactive-session', owner).filter(live).length >= 6)
          fail('Stop an existing control session first');
        const session = save('interactive-session', owner, {
          id: id(),
          taskId,
          runId:
            request?.runId ||
            list('run', owner).findLast(
              (run) => run.taskId === taskId && ['starting', 'running'].includes(run.status),
            )?.id,
          workerId: worker.id,
          instanceId: worker.instanceId,
          targetId: target.id,
          targetLabel: target.label,
          targetReason: target.reason,
          viewOnly: target.viewOnly === true,
          kind: target.kind,
          record: body.record === true,
          status: 'opening',
          controlOwner: request ? 'agent' : controller,
          generation: id(),
          createdAt: now(),
          updatedAt: now(),
          expiresAt: Date.now() + lifetime,
        });
        if (request)
          save('interactive-request', owner, {
            ...request,
            status: 'approved',
            sessionId: session.id,
          });
        event(owner, taskId, null, 'control.opening', {
          sessionId: session.id,
          workerId: worker.id,
          kind: target.kind,
          target: target.label,
        });
        return session;
      }
      const session = scoped(owner, taskId, body.sessionId);
      if (action === 'stop') return invalidate(owner, session, 'stopped', 'Stopped by user');
      if (!live(session)) fail('Session ended. Open a new session to revalidate the target.');
      if (action === 'takeover' || action === 'release') {
        if (action === 'release' && session.controlOwner !== controller)
          fail('Only the current user controller can return control to the agent');
        if (session.generation !== body.generation)
          fail('Control changed; refresh before taking over');
        for (const entry of list('interactive-command', owner).filter(
          (c) => c.sessionId === session.id && c.status === 'queued',
        ))
          save('interactive-command', owner, {
            ...entry,
            status: 'cancelled',
            error: 'Controller changed',
          });
        // Worker acknowledges the new generation only after any in-flight action has settled.
        return update(owner, session, {
          generation: id(),
          status: 'transferring',
          controlOwner: action === 'takeover' ? controller : 'agent',
          reason: 'Waiting for worker to finish the current interaction',
        });
      }
      if (action === 'input') return enqueue(owner, session, body, controller, null);
      throw new Error('Unknown control command');
    },
    signature,
  );
}
export function interactiveTool(scope: AgentScope, args: any) {
  const state = interactiveRead(scope.owner, scope.taskId);
  if (args.action === 'list') return { sessions: state.sessions, requests: state.requests };
  if (args.action === 'targets') return { targets: state.targets };
  if (args.action === 'request') {
    if (
      ![args.workerId, args.targetId, args.operationId].every(
        (v) => typeof v === 'string' && v.length > 0,
      )
    )
      throw new Error('Request requires workerId, targetId, and operationId');
    const signature = createHash('sha256')
      .update(JSON.stringify({ ...scope, args }))
      .digest('hex');
    const request = command(
      scope.owner,
      args.operationId,
      () => {
        const worker = get('interactive-worker', scope.owner, args.workerId);
        const target = state.targets.find(
          (t: any) => t.workerId === args.workerId && t.id === args.targetId && t.available,
        );
        if (!target) fail('This control target is unavailable');
        if ((target.viewOnly || target.desktopStatus) && args.record === true)
          fail('Linux desktop capture supports snapshots only');
        const existing = state.requests.find(
          (r: any) =>
            r.status === 'pending' &&
            r.workerId === args.workerId &&
            r.targetId === args.targetId &&
            r.instanceId === worker.instanceId,
        );
        if (existing) return existing;
        if (state.requests.filter((r: any) => r.status === 'pending').length >= 3)
          fail('Wait for the pending access requests');
        const request = save('interactive-request', scope.owner, {
          id: id(),
          taskId: scope.taskId,
          runId: scope.runId,
          workerId: worker.id,
          instanceId: worker.instanceId,
          targetId: target.id,
          targetLabel: target.label,
          targetReason: target.reason,
          viewOnly: target.viewOnly === true,
          // A whole Linux desktop whose owner allowed input: the card says the agent can click and type.
          desktopInput: target.desktopStatus?.inputAllowed === true && target.viewOnly !== true,
          kind: target.kind,
          record: args.record === true,
          status: 'pending',
          createdAt: now(),
          expiresAt: Date.now() + lifetime,
        });
        event(scope.owner, scope.taskId, scope.runId, 'control.requested', {
          requestId: request.id,
          target: target.label,
        });
        return request;
      },
      signature,
    );
    return autoApproveTaskBrowser(scope, request);
  }
  if (!['read', 'input', 'stop'].includes(args.action)) throw new Error('Use list, read, or input');
  if (typeof args.sessionId !== 'string' || !state.sessions.some((s) => s.id === args.sessionId))
    throw new Error(
      'Unknown sessionId for this task. Use list and copy the exact session id, not the target title.',
    );
  if (
    args.action === 'input' &&
    (typeof args.generation !== 'string' ||
      !args.generation ||
      typeof args.operationId !== 'string' ||
      !args.operationId ||
      !args.input)
  )
    throw new Error(
      'Input requires sessionId, generation from the latest read, a unique operationId, and input: {type, ...action fields}. Nothing was queued.',
    );
  const session = scoped(scope.owner, scope.taskId, args.sessionId);
  if (args.action === 'read')
    return {
      session,
      snapshot: interactiveSnapshot(scope.owner, scope.taskId, session.id),
      nextStep: interactiveSnapshot(scope.owner, scope.taskId, session.id)
        ? 'Use the observed evidence for input.'
        : 'Queue input type inspect first, then read until the snapshot exists. Do not click, scroll, or type yet.',
      commands: state.commands.filter((c: any) => c.sessionId === session.id),
    };
  if (args.action === 'stop') {
    if (typeof args.operationId !== 'string' || !args.operationId)
      throw new Error('operationId required');
    return command(
      scope.owner,
      args.operationId,
      () => {
        if (session.controlOwner !== 'agent')
          fail('Only the agent-owned session can be stopped through this tool');
        if (session.generation !== args.generation) fail('Control changed; read before stopping');
        return invalidate(scope.owner, session, 'stopped', 'Stopped by agent');
      },
      createHash('sha256')
        .update(JSON.stringify({ ...scope, args }))
        .digest('hex'),
    );
  }
  if (args.action !== 'input') throw new Error('Use targets, request, list, read, input, or stop');
  const signature = createHash('sha256')
    .update(JSON.stringify({ ...scope, args }))
    .digest('hex');
  return command(
    scope.owner,
    args.operationId,
    () => enqueue(scope.owner, session, { ...args, action: args.input }, 'agent', scope.runId),
    signature,
  );
}
export function interactiveWorker(owner: string, workerId: string, action: string, body: any) {
  return db
    .transaction(() => {
      if (workerId !== 'local' && get('worker', owner, workerId).instanceId !== body.instanceId)
        fail('Worker process changed');
      reconcile(owner);
      if (action === 'poll') {
        const targets = (Array.isArray(body.targets) ? body.targets : [])
          .slice(0, 128)
          .filter(
            (t: any) =>
              typeof t.id === 'string' &&
              t.id.length < 100 &&
              ['browser', 'computer'].includes(t.kind),
          )
          .map((t: any) => ({
            id: t.id,
            kind: t.kind,
            label: String(t.label).slice(0, 160),
            available: t.available === true,
            reason: String(t.reason || '').slice(0, 1000),
            viewOnly: t.kind === 'computer' && t.viewOnly === true,
            ...(t.kind === 'computer' && t.desktopStatus
              ? {
                  desktopStatus: {
                    available: t.available === true,
                    reason: String(t.reason || '').slice(0, 1000),
                    inputAllowed: t.viewOnly === false && t.desktopStatus.inputAllowed === true,
                    viewOnly: !(t.viewOnly === false && t.desktopStatus.inputAllowed === true),
                    sessionType: String(t.desktopStatus.sessionType || 'unknown').slice(0, 20),
                    desktop: String(t.desktopStatus.desktop || 'unknown').slice(0, 100),
                    socketPath: String(t.desktopStatus.socketPath || '').slice(0, 300),
                    portalAvailable:
                      typeof t.desktopStatus.portalAvailable === 'boolean'
                        ? t.desktopStatus.portalAvailable
                        : null,
                    grantStored:
                      typeof t.desktopStatus.grantStored === 'boolean'
                        ? t.desktopStatus.grantStored
                        : null,
                    screenLock: screenLockStatus(t.desktopStatus.screenLock),
                  },
                }
              : {}),
            // The Mac control helper's TCC state, shown in the computer's permissions.
            ...(t.kind === 'computer' && t.permissions && typeof t.permissions === 'object'
              ? {
                  permissions: {
                    screenRecording: t.permissions.screenRecording === true,
                    accessibility: t.permissions.accessibility === true,
                    unlocked: t.permissions.unlocked === true,
                  },
                }
              : {}),
          }));
        save('interactive-worker', owner, {
          id: workerId,
          instanceId: body.instanceId,
          targets,
          nodeCapabilities: parseNodeCapabilities(body.nodeCapabilities),
          heartbeat: now(),
        });
        const sessions: any[] = [];
        for (let session of list('interactive-session', owner).filter(
          (s) => s.workerId === workerId && live(s),
        )) {
          if (
            session.instanceId !== body.instanceId ||
            !targets.some((t: any) => t.id === session.targetId && t.available)
          ) {
            invalidate(
              owner,
              session,
              'suspended',
              'Worker, target, or capture/input permission changed',
            );
            continue;
          }
          const ack = (body.ready || []).find(
            (s: any) => s.id === session.id && s.generation === session.generation,
          );
          if (ack && ['opening', 'transferring'].includes(session.status))
            session = update(owner, session, { status: 'active', reason: null });
          save('interactive-session', owner, { ...session, heartbeat: now() });
          sessions.push(session);
        }
        return {
          sessions,
          commands: list('interactive-command', owner).filter(
            (c) =>
              c.status === 'queued' &&
              sessions.some(
                (s) =>
                  s.id === c.sessionId && s.status === 'active' && s.generation === c.generation,
              ),
          ),
        };
      }
      const session = get('interactive-session', owner, body.sessionId);
      if (session.workerId !== workerId || session.instanceId !== body.instanceId)
        fail('Session is not assigned to this worker');
      if (action === 'recording-error') {
        event(owner, session.taskId, session.runId || null, 'attachment.error', {
          sessionId: session.id,
          error: String(body.error).slice(0, 1000),
        });
        return { ok: true };
      }
      if (action === 'fail')
        return invalidate(
          owner,
          session,
          'suspended',
          String(body.error || 'Target unavailable').slice(0, 500),
        );
      const entry = get('interactive-command', owner, body.commandId);
      if (entry.sessionId !== session.id || entry.generation !== body.generation)
        fail('Stale control command');
      if (action === 'claim') {
        if (
          session.generation !== entry.generation ||
          session.status !== 'active' ||
          entry.status !== 'queued'
        )
          fail('Control command can no longer execute');
        if (entry.runId) {
          const run = get('run', owner, entry.runId);
          if (!['starting', 'running'].includes(run.status) || run.stopRequested) {
            return save('interactive-command', owner, {
              ...entry,
              status: 'cancelled',
              error: 'Agent run stopped',
              completedAt: now(),
            });
          }
        }
        return save('interactive-command', owner, {
          ...entry,
          status: 'running',
          startedAt: now(),
        });
      }
      if (action === 'complete') {
        if (entry.status !== 'running') return { accepted: false };
        const error = body.error ? String(body.error).slice(0, 500) : null;
        const result = body.snapshot;
        if (result && JSON.stringify(result).length > 1500000)
          throw new Error('Snapshot too large');
        save('interactive-command', owner, {
          ...entry,
          status: error ? 'unknown' : 'succeeded',
          error,
          completedAt: now(),
        });
        if (result && live(session))
          save('interactive-snapshot', owner, {
            ...result,
            id: session.id,
            capturedAt: now(),
            commandId: entry.id,
          });
        if (result?.image && live(session)) {
          try {
            createAttachment(owner, session.taskId, Buffer.from(result.image, 'base64'), {
              operationId: `frame:${entry.id}`,
              name: 'Computer screenshot',
              source: 'computer-use',
              runId:
                entry.runId ||
                session.runId ||
                list('run', owner)
                  .filter((r) => r.taskId === session.taskId)
                  .at(-1)?.id,
              sessionId: session.id,
              actionId: entry.id,
              kind: 'image',
            });
          } catch (failure: any) {
            event(owner, session.taskId, entry.runId, 'attachment.error', {
              error: failure.message,
            });
          }
        }
        event(owner, session.taskId, entry.runId, error ? 'control.unknown' : 'control.completed', {
          sessionId: session.id,
          commandId: entry.id,
          action: entry.args.type,
          error,
        });
        if (error)
          invalidate(owner, session, 'suspended', 'Interaction outcome uncertain: ' + error);
        return { accepted: true };
      }
      throw new Error('Unknown worker control command');
    })
    .immediate();
}

/**
 * Projects can always allow the headless task browser. The approval is recorded like a person's
 * (controller "project-setting") and noted in the conversation; desktop control still asks.
 */
function autoApproveTaskBrowser(scope: AgentScope, request: any) {
  if (request?.status !== 'pending' || request.kind !== 'browser') return request;
  const task = get('task', scope.owner, scope.taskId);
  if (!task.projectId) return request;
  let project: any;
  try {
    project = get('project', scope.owner, task.projectId);
  } catch {
    return request;
  }
  if (project.autoApproveTaskBrowser !== true) return request;
  const session = interactiveOperator(scope.owner, scope.taskId, 'approve', {
    operationId: 'auto-approve-' + request.id,
    clientId: 'project-setting',
    requestId: request.id,
  });
  event(scope.owner, scope.taskId, scope.runId, 'control.autoApproved', {
    requestId: request.id,
    target: request.targetLabel,
    project: project.name,
  });
  return { ...request, status: 'approved', autoApproved: true, sessionId: session.id };
}
