import {
  isDeploymentMessage,
  type DeploymentMessage,
} from '../../../server/deployment-notification-message.ts';

export interface NodeEventConfig {
  coordinatorUrl: string;
  nodeId: string;
  secret: string;
}

/** Live-only SSE; a reconnect does not request or replay historical notifications. */
export class DeploymentEventStream {
  private controller?: AbortController;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private backoff = 1000;

  private config: NodeEventConfig;
  private request: (url: string, options: RequestInit) => Promise<Response>;
  private received: (message: DeploymentMessage) => void;

  constructor(
    config: NodeEventConfig,
    request: (url: string, options: RequestInit) => Promise<Response>,
    received: (message: DeploymentMessage) => void,
  ) {
    this.config = config;
    this.request = request;
    this.received = received;
    void this.connect();
  }

  private async connect() {
    if (this.closed) return;
    const controller = (this.controller = new AbortController());
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), 70_000);
    };
    touch();
    try {
      const url = new URL('/api/agent/events', this.config.coordinatorUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      const response = await this.request(url.href, {
        headers: {
          'x-deploy-node-id': this.config.nodeId,
          'x-deploy-node-secret': this.config.secret,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.startsWith('text/event-stream')
      )
        throw new Error('Node event stream unavailable');
      const reader = (this.reader = response.body.getReader());
      const decoder = new TextDecoder();
      let buffer = '';
      let data: string[] = [];
      let dataLength = 0;
      try {
        while (!this.closed) {
          const chunk = await reader.read();
          if (chunk.done) break;
          touch();
          this.backoff = 1000;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length + dataLength > 65_536) throw new Error('Node event too large');
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line.startsWith('data:')) {
              const value = line.slice(5).replace(/^ /, '');
              data.push(value);
              dataLength += value.length;
            } else if (!line) {
              if (data.length) {
                try {
                  const message: unknown = JSON.parse(data.join('\n'));
                  if (isDeploymentMessage(message) && message.nodeId === this.config.nodeId)
                    this.received(message);
                } catch {
                  /* ignore malformed records, never log stream contents or credentials */
                }
              }
              data = [];
              dataLength = 0;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (this.reader === reader) this.reader = undefined;
      }
    } catch {
      // Network loss and coordinator restarts are routine; retry without logging secrets.
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      if (!this.closed) {
        this.timer = setTimeout(() => void this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    void this.reader?.cancel().catch(() => {});
    this.controller?.abort();
  }
}
