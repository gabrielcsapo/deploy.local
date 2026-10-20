import {
  isDeploymentMessage,
  type DeploymentMessage,
} from '../../../server/deployment-notification-message.ts';
import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import type { CoordinatorStatus } from './tray-model.ts';
/** Consume only validated status/fleet records and live deployment notices. */
export function applySupervisorMessage(
  state: CoordinatorStatus,
  value: any,
  deployment?: (message: DeploymentMessage) => void,
) {
  if (!value || typeof value !== 'object') return;
  if (isDeploymentMessage(value)) deployment?.(value);
  if (
    value.type === 'status' &&
    Array.isArray(value.children) &&
    value.children.length <= 128 &&
    value.children.every(
      (child: any) => child && typeof child.name === 'string' && typeof child.state === 'string',
    )
  )
    state.status = value;
  if (
    value.type === 'fleet' &&
    typeof value.dockerReachable === 'boolean' &&
    ['running', 'total', 'cpuCores', 'cpuPercent', 'memUsageBytes'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    )
  ) {
    state.fleet = value;
    state.fleetAt = Date.now();
  }
}

/** Same pushed NDJSON status/fleet stream as the coordinator's native status tray. */
export class SupervisorMonitor {
  state: CoordinatorStatus = { present: false, connected: false };
  private socket?: Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private path: string;
  private changed: () => void;
  private deployment?: (message: DeploymentMessage) => void;
  constructor(
    path: string,
    changed: () => void,
    deployment?: (message: DeploymentMessage) => void,
  ) {
    this.deployment = deployment;
    this.path = path;
    this.changed = changed;
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
          applySupervisorMessage(this.state, value, this.deployment);
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

/**
 * The supervisor socket for the systemd-managed server, from `systemctl show -p Environment
 * -p WorkingDirectory`. The server keeps its data in DEPLOY_DATA_DIR when the unit sets it
 * (releases change WorkingDirectory on every deploy); otherwise in <WorkingDirectory>/.deploy-data.
 */
export function socketFromServerUnit(show: string): string | null {
  const field = (name: string) =>
    show
      .split('\n')
      .find((line) => line.startsWith(name + '='))
      ?.slice(name.length + 1)
      .trim() || '';
  const environment = field('Environment');
  // systemd quotes a whole assignment that contains spaces: "DEPLOY_DATA_DIR=/a b".
  const match = /(?:^|\s)(?:"DEPLOY_DATA_DIR=([^"]*)"|DEPLOY_DATA_DIR=(\S+))/.exec(environment);
  const data = match?.[1] ?? match?.[2];
  if (data?.startsWith('/')) return data.replace(/\/$/, '') + '/supervisor.sock';
  const workingDirectory = field('WorkingDirectory');
  return workingDirectory.startsWith('/')
    ? workingDirectory.replace(/\/$/, '') + '/.deploy-data/supervisor.sock'
    : null;
}
