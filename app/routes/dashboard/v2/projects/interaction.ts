import { getAuth } from '../../../../auth';
import { authenticatedFetch, onAuthReset } from '../data/hooks';
import { interactionTracer } from '../../../../../packages/trace/interaction';

import {
  exportInteractions,
  observeWebFlows,
  observeNavigation,
  routeFamily,
} from '../../../../../packages/trace/otlp';
const families =
  'account agents approvals apps artifacts attachments auth backups catalog composer computers config conversation-attachments deployments design devices diagnostics git identity inbox live login machines models nodes notifications packages projects pulls releases repositories repository-projects runs search services settings state task-snapshots tasks tokens user workers workspace'.split(
    ' ',
  );
const screens =
  'projects inbox tasks agents live computers settings packages artifacts design apps'.split(' ');
let navigation: ReturnType<typeof observeNavigation> | undefined;
export const commitScreen = (path: string) => navigation?.committed(path);
export function startScreenOpen(path: string, name: string) {
  const tracer = projectTracer();
  if (!tracer) return;
  const open = navigation?.take(path) ?? tracer.start(name);
  return {
    open,
    pageLeft() {
      open.finish('navigation.left', 'cancelled');
      queueMicrotask(() => void tracer.flush(true));
    },
  };
}
let current:
  | {
      owner: string;
      tracer: ReturnType<typeof interactionTracer>;
      close: () => void;
    }
  | undefined;

export function projectTracer() {
  const owner = getAuth()?.username;
  if (current?.owner === owner) return current?.tracer;
  current?.close();
  if (!owner) return;
  let storage: Storage | undefined;
  try {
    storage = sessionStorage;
  } catch {}
  const tracer = interactionTracer({
    scope: 'control.' + owner,
    origin: location.origin,
    storage,
    sendBatch: async (events, keepalive) => {
      if (getAuth()?.username !== owner) return false;
      const response = await authenticatedFetch('/api/control/otel/v1/traces', {
        method: 'POST',
        keepalive,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          exportInteractions(
            events,
            'deployDesktop' in window ? 'deploy.electron.renderer' : 'deploy.web',
          ),
        ),
      });
      return response.ok || response.status === 400;
    },
  });
  const stopRequests = observeWebFlows(tracer, (path, method) => {
    const family = routeFamily(path, '/api/', families);
    if (!family || family === 'other' || family === 'activity-events' || family === 'events')
      return;
    return 'http.' + method.toLowerCase() + '.' + family;
  });
  navigation = observeNavigation(tracer, (path) => {
    const family = routeFamily(path, '/dashboard/', screens);
    return family && family !== 'other' ? 'screen.' + family + '.open' : undefined;
  });
  const flush = () => void tracer.flush();
  function close() {
    navigation?.close();
    navigation = undefined;
    stopRequests();
    tracer.close();
    unsubscribe();
    window.removeEventListener('online', flush);
    current = undefined;
  }
  const unsubscribe = onAuthReset(close);
  window.addEventListener('online', flush);
  current = { owner, tracer, close };
  flush();
  return tracer;
}

export function markProjectOpen(key: string) {
  if (!projectTracer()) return;
  try {
    sessionStorage.setItem(
      'trace.project.tap',
      JSON.stringify([key, getAuth()?.username, performance.timeOrigin + performance.now()]),
    );
  } catch {}
}

export function startProjectOpen(key: string) {
  const tracer = projectTracer();
  if (!tracer) return;
  let start = performance.now();
  try {
    const [project, owner, at] = JSON.parse(sessionStorage.getItem('trace.project.tap') || '[]');
    sessionStorage.removeItem('trace.project.tap');
    const elapsed = performance.timeOrigin + performance.now() - at;
    if (project === key && owner === getAuth()?.username && elapsed >= 0 && elapsed < 30000)
      start -= elapsed;
  } catch {}
  return tracer.start('project.open', start);
}
