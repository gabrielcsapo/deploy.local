import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir, hostname, platform } from 'node:os';
import { roles } from './model.mjs';
// Where `deploy agent join` keeps this computer's enrollment (bin/agent-enrollment.mjs).
function agentConfigPaths(env = process.env, home = homedir()) {
  if (env.DEPLOY_AGENT_CONFIG) return [env.DEPLOY_AGENT_CONFIG];
  if (platform() === 'darwin')
    return [join(home, 'Library/Application Support/deploy.local/agent.json')];
  return [
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'deploy.local/agent.json'),
    '/var/lib/deploy.local/agent.json',
  ];
}
/** The node this computer is enrolled as on `origin`, so its desktop worker joins that computer. */
export function localNodeId(origin, paths = agentConfigPaths()) {
  for (const path of paths) {
    try {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      if (new URL(config.coordinatorUrl).origin === origin && typeof config.nodeId === 'string')
        return config.nodeId;
    } catch {}
  }
  return undefined;
}
export class WorkerManager {
  constructor({
    root,
    executable,
    entry,
    helper,
    onChange = () => {},
    onControls = () => {},
    spawnChild = spawn,
    nodeId = localNodeId,
  }) {
    Object.assign(this, {
      root,
      executable,
      entry,
      helper,
      onChange,
      onControls,
      spawnChild,
      nodeId,
    });
    this.state = 'Stopped';
    this.selection = roles({});
    this.child = null;
  }
  status() {
    return {
      state: this.state,
      name: hostname(),
      roles: this.selection,
      screenSupported: process.platform === 'darwin' && !!this.helper,
    };
  }
  async configure(value, client, enrollment) {
    const selection = roles(value, process.platform, !!this.helper);
    await this.stop();
    this.selection = selection;
    if (!selection.takeTasks) {
      this.onChange();
      return enrollment;
    }
    if (!enrollment)
      enrollment = await client.request('/api/workspace/workers/enroll', {
        method: 'POST',
        body: { workerId: `desktop-${randomUUID()}`, operationId: randomUUID() },
      });
    this.connection = { client, enrollment };
    this.launch();
    return enrollment;
  }
  launch() {
    if (this.child || !this.selection.takeTasks) return;
    const { client, enrollment } = this.connection;
    const root = join(this.root, enrollment.workerId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SystemRoot: process.env.SystemRoot,
      ELECTRON_RUN_AS_NODE: '1',
      DEPLOY_COORDINATOR_URL: client.origin,
      DEPLOY_WORKER_ID: enrollment.workerId,
      DEPLOY_WORKER_TOKEN: enrollment.workerToken,
      DEPLOY_WORKER_ROOT: root,
      DEPLOY_WORKER_NAME: hostname(),
      DEPLOY_NODE_ID: this.nodeId(client.origin) || '',
      DEPLOY_DESKTOP_PIN: client.pin || '',
      DEPLOY_DESKTOP_HELPER: this.selection.useScreen ? this.helper : '',
      DEPLOY_BROWSER_CONTROL: '0',
    };
    const child = this.spawnChild(this.executable, [this.entry], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    this.state = 'Starting';
    this.onChange();
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('message', (message) => {
      if (message?.type === 'controls') this.onControls(message.taskIds);
      if (message?.type === 'heartbeat') {
        this.state = message.online ? 'Ready for tasks' : 'Disconnected';
        this.onChange();
      }
    });
    child.once('error', () => {
      this.state = 'Could not start';
      this.onChange();
    });
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.state = 'Stopped';
      this.onChange();
      if (!this.stopping && this.selection.takeTasks)
        this.restart = setTimeout(() => this.launch(), 5000);
    });
  }
  async stop() {
    clearTimeout(this.restart);
    this.stopping = true;
    const child = this.child;
    if (child)
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    this.child = null;
    this.state = 'Stopped';
    this.stopping = false;
  }
}
