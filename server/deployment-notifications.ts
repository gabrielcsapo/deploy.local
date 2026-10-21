import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployEvent } from './events.ts';
import type { DeploymentMessage } from './deployment-notification-message.ts';

type Deployment = {
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
  username: string;
};
type Lookup = {
  deployment: (name: string) => Deployment | null | undefined;
  node: (id: string) => { name: string } | null | undefined;
};

export function normalizeDeploymentNotification(
  event: DeployEvent,
  lookup: Lookup,
  at = Date.now(),
): DeploymentMessage | null {
  if (
    event.type !== 'deployment:status' ||
    ['startup', 'sync', 'restart', 'recreate'].includes(event.data.source) ||
    !['building', 'running', 'failed'].includes(event.data.status)
  )
    return null;
  const deployment = lookup.deployment(event.deploymentName);
  if (!deployment) return null;
  const nodeId =
    (typeof event.data.nodeId === 'string' && event.data.nodeId) ||
    deployment.activeNodeId ||
    deployment.desiredNodeId ||
    'coordinator';
  return {
    type: 'deployment',
    name: event.deploymentName,
    status: event.data.status,
    nodeId,
    nodeName: lookup.node(nodeId)?.name || nodeId,
    username: typeof event.data.username === 'string' ? event.data.username : deployment.username,
    at,
    ...(typeof event.data.trigger === 'string' ? { trigger: event.data.trigger } : {}),
  };
}

export class DeploymentNotifications {
  private subscribers = new Set<(message: DeploymentMessage) => void>();
  private streams = new Map<string, Set<ServerResponse>>();

  subscribe(handler: (message: DeploymentMessage) => void) {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  publish(message: DeploymentMessage) {
    for (const handler of this.subscribers) handler(message);
  }

  stream(
    req: IncomingMessage,
    res: ServerResponse,
    authenticate: (id: string | undefined, secret: string | undefined) => boolean,
    deployEnabled: (id: string) => boolean = () => true,
  ) {
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const nodeId = header('x-deploy-node-id');
    const secret = header('x-deploy-node-secret');
    if (!nodeId || !authenticate(nodeId, secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid node credential' }));
      return;
    }
    const streams = this.streams.get(nodeId) || new Set<ServerResponse>();
    // The newest stream wins: a desktop that vanished without closing (sleep, Wi-Fi loss)
    // must not lock its node out of notifications when it reconnects.
    while (streams.size >= 2) {
      const oldest = streams.values().next().value!;
      streams.delete(oldest);
      oldest.destroy();
    }
    streams.add(res);
    this.streams.set(nodeId, streams);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (line: string) => {
      // A stalled desktop must not accumulate unbounded coordinator memory.
      if (!res.write(line)) res.destroy();
    };
    const unsubscribe = this.subscribe((message) => {
      if (nodeId === 'coordinator' || deployEnabled(nodeId))
        write(`data: ${JSON.stringify(message)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      // Revoked credentials also terminate an already-open stream.
      if (!authenticate(nodeId, secret)) res.end();
      else write(': heartbeat\n\n');
    }, 25_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
      if (!streams.size) this.streams.delete(nodeId);
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
    write(': connected\n\n');
  }
}
