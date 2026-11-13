import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';
import { fail } from '../errors.ts';
import { isAdmin } from '../store.ts';

/**
 * The server measuring itself, for an administrator: where its main thread spends its time and
 * which requests arrived meanwhile. The profiler runs inside this process, so no debugger port
 * is opened and nobody needs a shell on the computer.
 */

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type Node = { id: number; callFrame: Frame; children?: number[] };
export type CpuProfile = {
  nodes: Node[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
};
type RouteTiming = { count: number; totalMs: number; maxMs: number };

let collecting: Map<string, RouteTiming> | null = null;

/** Ids vary per request; the route is what a person recognises. */
export function routeName(method: string, path: string) {
  const segments = path
    .split('?')[0]
    .split('/')
    .map((segment) => {
      let part = segment;
      try {
        part = decodeURIComponent(segment);
      } catch {
        /* Keep the raw segment. */
      }
      return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(part) ||
        /^[0-9a-f]{12,}$/i.test(part) ||
        /^\d+$/.test(part) ||
        /[:~]/.test(part)
        ? ':id'
        : segment;
    });
  return `${method} ${segments.join('/')}`;
}

/** Called for every request; does nothing unless a profile is being taken. */
export function observeRequest(req: IncomingMessage, res: ServerResponse, path: string) {
  const routes = collecting;
  if (!routes) return;
  const started = performance.now();
  const route = routeName(req.method || 'GET', path);
  res.once('close', () => {
    const ms = performance.now() - started;
    const timing = routes.get(route) ?? { count: 0, totalMs: 0, maxMs: 0 };
    timing.count += 1;
    timing.totalMs += ms;
    timing.maxMs = Math.max(timing.maxMs, ms);
    routes.set(route, timing);
  });
}

const where = (frame: Frame) =>
  frame.url
    ? `${frame.url.replace(/^file:\/\//, '').replace(/^.*\/(dist|node_modules)\//, '$1/')}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    : '';

/** Self time by function and time by top-level cause, as shares of the time the thread was busy. */
export function summarizeProfile(profile: CpuProfile, limit = 40) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const total = profile.endTime - profile.startTime;
  let idle = 0;
  const self = new Map<string, { functionName: string; where: string; micros: number }>();
  const inclusive = new Map<string, { functionName: string; where: string; micros: number }>();
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    const micros = profile.timeDeltas[index] ?? 0;
    if (!node) return;
    if (node.callFrame.functionName === '(idle)') {
      idle += micros;
      return;
    }
    const add = (into: typeof self, frame: Frame) => {
      const key = `${frame.functionName}|${where(frame)}`;
      const entry = into.get(key) ?? {
        functionName: frame.functionName || '(anonymous)',
        where: where(frame),
        micros: 0,
      };
      entry.micros += micros;
      into.set(key, entry);
    };
    add(self, node.callFrame);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const frame = byId.get(at)!.callFrame;
      const key = `${frame.functionName}|${where(frame)}`;
      if (seen.has(key) || frame.functionName === '(root)') continue;
      seen.add(key);
      add(inclusive, frame);
    }
  });
  const busy = Math.max(total - idle, 1);
  const top = (entries: typeof self) =>
    [...entries.values()]
      .sort((a, b) => b.micros - a.micros)
      .slice(0, limit)
      .map((entry) => ({
        percent: Math.round((1000 * entry.micros) / busy) / 10,
        functionName: entry.functionName,
        where: entry.where,
      }));
  return {
    seconds: Math.round(total / 1e4) / 100,
    busyPercent: Math.round((1000 * (total - idle)) / Math.max(total, 1)) / 10,
    samples: profile.samples.length,
    self: top(self),
    inclusive: top(inclusive),
  };
}

/** Profile this process's main thread for a while. One at a time. */
export async function profileSelf(seconds: number) {
  if (collecting) fail('A profile is already being taken', 409);
  const routes = new Map<string, RouteTiming>();
  collecting = routes;
  const session = new Session();
  const loop = performance.eventLoopUtilization();
  try {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
    await session.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const { profile } = (await session.post('Profiler.stop')) as { profile: CpuProfile };
    const used = performance.eventLoopUtilization(loop);
    return {
      profile,
      summary: {
        ...summarizeProfile(profile),
        eventLoopUtilization: Math.round(used.utilization * 1000) / 10,
        routes: [...routes]
          .map(([route, timing]) => ({
            route,
            count: timing.count,
            totalMs: Math.round(timing.totalMs),
            averageMs: Math.round((10 * timing.totalMs) / timing.count) / 10,
            maxMs: Math.round(timing.maxMs),
          }))
          .sort((a, b) => b.totalMs - a.totalMs)
          .slice(0, 60),
      },
    };
  } finally {
    collecting = null;
    try {
      session.disconnect();
    } catch {
      /* Already closed. */
    }
  }
}

export async function diagnosticsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname !== '/api/v2/diagnostics/profile') return false;
  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405);
    return true;
  }
  if (!isAdmin(owner)) fail('Only an administrator can profile the server', 403);
  const seconds = Number(url.searchParams.get('seconds') ?? 30);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120)
    fail('seconds must be between 1 and 120');
  const { profile, summary } = await profileSelf(seconds);
  // The whole profile opens in a profiler's flame chart; the summary is what to read first.
  sendJson(res, url.searchParams.get('raw') === '1' ? { summary, profile } : { summary });
  return true;
}
