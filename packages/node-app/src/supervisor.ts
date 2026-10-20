import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import type { CoordinatorStatus } from './tray-model.ts';
/** Same pushed NDJSON status/fleet stream as the coordinator's native status tray. */
export class SupervisorMonitor {
  state: CoordinatorStatus = { present: false, connected: false };
  private socket?: Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private path: string,
    private changed: () => void,
  ) {
    this.reconnect();
  }
  private reconnect() {
    if (this.closed) return;
    this.state.present ||= existsSync(this.path);
    const socket = (this.socket = connect(this.path));
    let buffer = '';
    socket.on('connect', () => {
      this.state.present = true;
      this.state.connected = true;
      this.changed();
    });
    socket.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) return socket.destroy();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (
            value.type === 'status' &&
            Array.isArray(value.children) &&
            value.children.length <= 128 &&
            value.children.every(
              (child: any) =>
                child && typeof child.name === 'string' && typeof child.state === 'string',
            )
          )
            this.state.status = value;
          if (
            value.type === 'fleet' &&
            typeof value.dockerReachable === 'boolean' &&
            ['running', 'total', 'cpuCores', 'cpuPercent', 'memUsageBytes'].every(
              (key) =>
                typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
            )
          ) {
            this.state.fleet = value;
            this.state.fleetAt = Date.now();
          }
        } catch {
          /* ignore malformed lines */
        }
      }
      this.changed();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.state.connected = false;
      this.state.status = undefined;
      this.changed();
      if (!this.closed) this.timer = setTimeout(() => this.reconnect(), 3000);
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }
}
