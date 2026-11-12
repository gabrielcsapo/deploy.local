import { access, readFile, writeFile, mkdir, rename, copyFile, chmod, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runBounded } from '../../bin/bounded-command.mjs';
import { ensureWorkerBuild } from '../../bin/agent-install.mjs';
import { joinAgent } from '../../bin/agent-enrollment.mjs';
import {
  workerExecutablePaths,
  workerAppInfoPlist,
  WORKER_APP_ID,
} from '../../bin/agent-services.mjs';
import { servicePath } from './worker-path.mjs';

const label = 'sh.deploy.agent';
const systemPlist = '/Library/LaunchDaemons/sh.deploy.agent.plist';
const xml = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const exists = async (path, mode) => {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
};
const checked = (result, action) => {
  if (result.status !== 0)
    throw new Error(
      `${action} failed${result.timedOut ? ' (timed out)' : ''}. ${result.stderr || ''}`.trim(),
    );
  return result;
};
export const dockerName = (runtime) =>
  ({ colima: 'Colima', 'docker-desktop': 'Docker Desktop', orbstack: 'OrbStack', other: 'Docker' })[
    runtime
  ] || 'Docker';

/** Owns only the execution agent. Never stops the desktop's task worker or removes enrollment. */
export class AppWorker {
  constructor({
    client,
    home = homedir(),
    uid = process.getuid?.(),
    platform = process.platform,
    arch = process.arch,
    name = hostname(),
    run = runBounded,
    sleep = delay,
    now = Date.now,
    ensure = ensureWorkerBuild,
    enroll = joinAgent,
    onProgress = () => {},
    systemFile = systemPlist,
  } = {}) {
    Object.assign(this, {
      client,
      home,
      uid,
      platform,
      arch,
      name,
      run,
      sleep,
      now,
      ensure,
      enroll,
      onProgress,
      systemFile,
    });
    this.root = join(home, 'Library/Application Support/deploy.local');
    this.configPath = join(this.root, 'agent.json');
    this.marker = join(this.root, 'desktop-worker.json');
    this.plist = join(home, 'Library/LaunchAgents/sh.deploy.agent.plist');
    this.paths = workerExecutablePaths(this.root, {
      platform: 'darwin',
      app: join(home, 'Applications/deploy.local Worker.app'),
    });
    this.domain = `gui/${uid}`;
    this.target = `${this.domain}/${label}`;
    this.path =
      servicePath([], process.env.PATH, home) +
      ':' +
      join(home, '.docker/bin') +
      ':/Applications/Docker.app/Contents/Resources/bin';
    this.run = (command, args, options) =>
      run(command, args, { ...options, env: { ...process.env, PATH: this.path } });
    this.last = null;
  }
  supported() {
    if (this.platform !== 'darwin') throw new Error('Run apps is not supported here yet.');
    if (!this.uid) throw new Error('Open the desktop app from your normal Mac login.');
  }
  async config() {
    try {
      return JSON.parse(await readFile(this.configPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('The worker enrollment cannot be read. It has been kept.', { cause: error });
    }
  }
  matching(config) {
    try {
      return new URL(config?.coordinatorUrl).origin === this.client.origin && !!config.nodeId;
    } catch {
      return false;
    }
  }
  async executable(name) {
    for (const dir of this.path.split(':')) {
      const path = join(dir, name);
      if (await exists(path, constants.X_OK)) return path;
    }
    return null;
  }
  async docker() {
    const command = await this.executable('docker');
    if (!command) return { found: false, runtime: null, answering: false };
    const context = await this.run(command, ['context', 'show'], { timeoutMs: 3000 });
    const text = context.stdout?.trim() || '';
    // Stopping Colima hands Docker back to its default context, so a stopped Colima looks like
    // "other". If Colima is installed and set up here and nothing else is selected, it is Colima.
    const colimaSetUp =
      (!text || text === 'default') &&
      !!(await this.executable('colima')) &&
      (await exists(join(this.home, '.colima/default/colima.yaml')));
    const runtime =
      /colima/i.test(text) || colimaSetUp
        ? 'colima'
        : /orbstack/i.test(text)
          ? 'orbstack'
          : /desktop/i.test(text)
            ? 'docker-desktop'
            : 'other';
    const result = await this.run(command, ['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 5000,
    });
    return { found: true, runtime, answering: result.status === 0 };
  }
  async service() {
    const result = await this.run('/bin/launchctl', ['print', this.target], { timeoutMs: 5000 });
    this.loadedProgram = result.stdout?.match(/^\s*program = (.+)$/m)?.[1]?.replace(/^"|"$/g, '');
    return {
      loaded: result.status === 0,
      running: result.status === 0 && /state = running\b/.test(result.stdout),
    };
  }
  async detect() {
    if (this.platform !== 'darwin')
      return {
        install: 'none',
        service: { loaded: false, running: false },
        leftover: [],
        docker: { found: false, runtime: null, answering: false },
        supported: false,
      };
    const [config, service, docker] = await Promise.all([
      this.config(),
      this.service(),
      this.docker(),
    ]);
    let marker;
    try {
      marker = JSON.parse(await readFile(this.marker, 'utf8'));
    } catch {}
    const matches = this.matching(config);
    const leftover = [];
    if (await exists(this.systemFile)) {
      const system = await this.run('/bin/launchctl', ['print', `system/${label}`], {
        timeoutMs: 5000,
      });
      // A system-wide copy blocks a move only when it is the worker in use. One that launchd keeps
      // restarting after it fails, or that sits beside this user's running worker, is a leftover:
      // it reads "running" for the instant between two failed starts.
      const failing =
        Number(system.stdout?.match(/^\s*runs = (\d+)$/m)?.[1] || 0) > 3 &&
        Number(system.stdout?.match(/^\s*last exit code = (-?\d+)$/m)?.[1] || 0) !== 0;
      this.systemRunning =
        system.status === 0 &&
        /state = running\b/.test(system.stdout) &&
        !failing &&
        !(matches && service.running);
      if (!this.systemRunning) leftover.push({ path: this.systemFile, needsPassword: true });
    } else this.systemRunning = false;
    return {
      install: matches
        ? marker?.managedBy === 'deploy.local Desktop' &&
          marker?.nodeId === config.nodeId &&
          marker?.coordinatorUrl === this.client.origin
          ? 'desktop'
          : 'command-line'
        : 'none',
      nodeId: matches ? config.nodeId : undefined,
      name: matches ? config.name : undefined,
      service,
      leftover,
      docker,
    };
  }
  async exclusive(action) {
    this.supported();
    if (this.busy) throw new Error('The worker is already being changed. Wait for it to finish.');
    this.busy = true;
    this.operation = (async () => {
      try {
        return await action();
      } finally {
        this.busy = false;
        this.cachedAt = undefined;
        this.onProgress('');
      }
    })();
    return this.operation;
  }
  install() {
    return this.exclusive(async () => {
      const detected = await this.detect();
      if (await this.config())
        throw new Error('This Mac already has a worker. Move it to this app instead.');
      if (this.systemRunning)
        throw new Error('An all-users worker is still running. It has been kept.');
      if (!detected.docker.found)
        throw new Error('Install Docker on this Mac before turning on Run apps.');
      this.onProgress('Adding this computer…');
      const { code } = await this.client.request('/api/v2/computers/enrollment', {
        method: 'POST',
        body: { name: this.name },
      });
      await this.enroll({
        coordinatorUrl: this.client.origin,
        code,
        name: this.name,
        roles: { deploy: true, tasks: false, computer: false, browser: false },
        configPath: this.configPath,
        request: async (url, options) => {
          const value = await this.client.request(url, {
            method: options.method,
            body: JSON.parse(options.body),
          });
          return { ok: true, json: async () => value };
        },
      });
      // Keep enrollment even if download fails; Repair or Move retries without creating a new node.
      await this.rebuild();
      await this.mark();
      return this.status(true);
    });
  }
  takeOver() {
    return this.exclusive(async () => {
      const detected = await this.detect();
      if (detected.install === 'none') throw new Error('No worker for this coordinator was found.');
      if (this.systemRunning)
        throw new Error('An all-users worker is still running. It has been kept.');
      await this.rebuild();
      await this.mark();
      return this.status(true);
    });
  }
  repair() {
    return this.takeOver();
  }
  async mark() {
    const config = await this.config();
    await this.atomic(
      this.marker,
      JSON.stringify({
        managedBy: 'deploy.local Desktop',
        coordinatorUrl: this.client.origin,
        nodeId: config.nodeId,
      }) + '\n',
    );
  }
  async atomic(path, text) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, text, { mode: 0o600 });
      await rename(staged, path);
    } finally {
      await rm(staged, { force: true });
    }
  }
  async buildInfo(path) {
    const result = checked(
      await this.run(path, ['version', '--json'], { timeoutMs: 30000 }),
      'Worker startup check',
    );
    return JSON.parse(result.stdout);
  }
  async seal(app, { signSupervisor = false } = {}) {
    const plist = join(app, 'Contents/Info.plist');
    if (!(await exists(plist)))
      await writeFile(plist, workerAppInfoPlist({ minimumVersion: '13.0' }));
    if (signSupervisor)
      checked(
        await this.run(
          '/usr/bin/codesign',
          ['--force', '--sign', '-', '--identifier', WORKER_APP_ID, this.paths.supervisor],
          { timeoutMs: 30000 },
        ),
        'Worker supervisor signing',
      );
    checked(
      await this.run('/usr/bin/codesign', ['--force', '--sign', '-', app], { timeoutMs: 30000 }),
      'Worker signing',
    );
    checked(
      await this.run('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], {
        timeoutMs: 30000,
      }),
      'Worker verification',
    );
  }
  async download(_url, path, _version, previous, { manifest }) {
    const target = manifest.targets?.[`darwin-${this.arch}`];
    if (
      !target ||
      !/^[a-f0-9]{64}$/.test(target.sha256) ||
      !Number.isSafeInteger(target.size) ||
      target.size <= 0 ||
      target.size > 1024 ** 3
    )
      throw new Error('The coordinator worker manifest is invalid.');
    const staged = `${path}.${randomUUID()}.stage`;
    try {
      this.onProgress('Downloading the worker…');
      await this.client.download(
        `/cli?os=darwin&arch=${this.arch}&version=${encodeURIComponent(manifest.version)}`,
        staged,
        { size: target.size, signal: AbortSignal.timeout(120000), onProgress: () => {} },
      );
      const bytes = await readFile(staged);
      if (
        bytes.length !== target.size ||
        createHash('sha256').update(bytes).digest('hex') !== target.sha256
      )
        throw new Error('Worker checksum or size mismatch; the installed build was kept.');
      await chmod(staged, 0o755);
      checked(
        await this.run('/usr/bin/codesign', ['--sign', '-', '--force', staged], {
          timeoutMs: 30000,
        }),
        'Worker signing',
      );
      const info = await this.buildInfo(staged);
      if (info.version !== manifest.version || (manifest.commit && info.commit !== manifest.commit))
        throw new Error('The worker build does not match the coordinator release.');
      if (await exists(path)) await copyFile(path, previous);
      await rename(staged, path);
    } finally {
      await rm(staged, { force: true });
    }
  }
  async rebuild() {
    this.onProgress('Checking the worker…');
    const config = await this.config();
    if (!this.matching(config))
      throw new Error('The worker belongs to another coordinator. It has been kept.');
    const originalPlist = await readFile(this.plist, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    await this.ensure(this.client.origin, this.root, {
      paths: this.paths,
      platform: 'darwin',
      arch: this.arch,
      readBuildInfo: (path) => this.buildInfo(path),
      manifestFor: () => this.client.request('/cli/version'),
      download: (...args) => this.download(...args),
      seal: (...args) => this.seal(...args),
      print: () => {},
      restartServices: async ({ changed, rollback }) => {
        if (rollback && originalPlist) await this.atomic(this.plist, originalPlist);
        // The supervisor is kept across repairs, so it may be older than the worker it now starts.
        // It accepts a worker as ready only at the version its update record names; without the
        // record it expects its own version and replaces a newer worker every minute.
        if (!rollback) {
          const installed = await this.buildInfo(this.paths.executable);
          const record = join(this.root, 'data', 'worker-update.json');
          const expected = await readFile(record, 'utf8')
            .then((text) => JSON.parse(text))
            .then((receipt) => (receipt.state === 'complete' ? receipt.version : undefined))
            .catch(() => undefined);
          const supervisor = await this.buildInfo(this.paths.supervisor).catch(() => ({}));
          if ((expected ?? supervisor.version) !== installed.version) {
            await this.atomic(
              record,
              JSON.stringify({
                state: 'complete',
                version: installed.version,
                targetVersion: installed.version,
                confirmedAt: Date.now(),
              }),
            );
            // The supervisor reads the record only when it starts.
            changed = true;
          }
        }
        await this.startService({ changed, rollback, originalPlist });
      },
    });
  }
  async startService({ changed, rollback, originalPlist }) {
    const service = await this.service();
    let hasSupervisor = await exists(this.paths.supervisor);
    if (hasSupervisor && !rollback) {
      try {
        const info = await this.buildInfo(this.paths.supervisor);
        const signature = await this.run(
          '/usr/bin/codesign',
          ['--verify', '--strict', this.paths.supervisor],
          { timeoutMs: 30000 },
        );
        hasSupervisor =
          typeof info.version === 'string' && !!info.version && signature.status === 0;
      } catch {
        hasSupervisor = false;
      }
    }
    // The existing supervisor's inode and identity must survive upgrades of its child.
    if (!hasSupervisor) {
      const staged = `${this.paths.supervisor}.${randomUUID()}.stage`;
      try {
        await copyFile(this.paths.executable, staged);
        await chmod(staged, 0o755);
        await rename(staged, this.paths.supervisor);
      } finally {
        await rm(staged, { force: true });
      }
      await this.seal(this.paths.app, { signSupervisor: true });
    }
    if (!rollback && hasSupervisor) {
      const verified = await this.run(
        '/usr/bin/codesign',
        ['--verify', '--strict', '--deep', this.paths.app],
        { timeoutMs: 30000 },
      );
      if (verified.status !== 0) await this.seal(this.paths.app, { signSupervisor: false });
    }
    const sameProgram =
      (!this.loadedProgram || this.loadedProgram === this.paths.supervisor) &&
      originalPlist?.includes(xml(this.paths.supervisor)) &&
      originalPlist.includes(xml(this.configPath));
    if (sameProgram && service.loaded) {
      if (changed || rollback || !service.running || !hasSupervisor)
        checked(
          await this.run('/bin/launchctl', ['kickstart', '-k', this.target], { timeoutMs: 15000 }),
          'Worker restart',
        );
      return;
    }
    if (!rollback || !originalPlist) {
      await mkdir(join(this.root, 'data'), { recursive: true });
      const logs = join(this.home, 'Library/Logs/deploy.local');
      await mkdir(logs, { recursive: true });
      const ca = join(this.root, 'desktop-coordinator-ca.pem');
      if (this.client.pin)
        await this.atomic(ca, await this.client.request('/ca.crt', { raw: true }));
      const env = {
        PATH: this.path,
        DEPLOY_AGENT_CONFIG: this.configPath,
        DEPLOY_DATA_DIR: join(this.root, 'data'),
        ...(this.client.pin ? { NODE_EXTRA_CA_CERTS: ca } : {}),
      };
      await this.atomic(
        this.plist,
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(this.paths.supervisor)}</string><string>agent</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>WorkingDirectory</key><string>${xml(this.root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
          env,
        )
          .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
          .join('')}</dict>
<key>StandardOutPath</key><string>${xml(join(logs, 'agent.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs, 'agent.err.log'))}</string></dict></plist>\n`,
      );
    }
    this.onProgress('Starting the worker…');
    // All writes/checks finish before a stop. A start is attempted even if bootout fails/times out.
    try {
      if (service.loaded)
        await this.run('/bin/launchctl', ['bootout', this.target], { timeoutMs: 15000 });
    } finally {
      let loaded;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await this.sleep(500 * attempt);
        loaded = await this.run('/bin/launchctl', ['bootstrap', this.domain, this.plist], {
          timeoutMs: 15000,
        });
        if (loaded.status === 0) break;
      }
      // Kickstart even after a failed bootstrap: launchd may have retained the original service.
      const started = await this.run('/bin/launchctl', ['kickstart', '-k', this.target], {
        timeoutMs: 15000,
      });
      checked(started.status === 0 ? started : loaded, 'Worker start');
      checked(started, 'Worker start');
    }
  }
  restartDocker() {
    return this.exclusive(async () => {
      const docker = await this.docker();
      if (docker.runtime !== 'colima')
        throw new Error(
          `${dockerName(docker.runtime)} on this computer has to be restarted by hand.`,
        );
      const colima = await this.executable('colima');
      if (!colima) throw new Error('Colima could not be found on this Mac.');
      this.onProgress('Stopping Colima…');
      // Even a timed-out stop is followed by start, so recovery is never left halfway through.
      await this.run(colima, ['stop', '--force'], { timeoutMs: 60000 });
      this.onProgress('Starting Colima…');
      let result = await this.run(colima, ['start'], { timeoutMs: 180000 });
      if (result.status !== 0) {
        this.onProgress('Waiting for Colima’s network helper…');
        await this.sleep(5000);
        this.onProgress('Starting Colima again…');
        result = await this.run(colima, ['start'], { timeoutMs: 180000 });
      }
      checked(result, 'Colima start');
      return this.status(true);
    });
  }
  removeLeftover(path) {
    return this.exclusive(async () => {
      const detected = await this.detect();
      if (
        detected.install !== 'desktop' ||
        !detected.service.running ||
        path !== systemPlist ||
        path !== this.systemFile ||
        !detected.leftover.some((e) => e.path === path)
      )
        throw new Error('Only the unused all-users copy can be removed after the move.');
      // Fixed paths and label only; no renderer text is interpolated into the elevated command.
      const script =
        'do shell script "/bin/launchctl bootout system/sh.deploy.agent >/dev/null 2>&1; if /bin/launchctl print system/sh.deploy.agent >/dev/null 2>&1; then exit 1; fi; /bin/rm -f /Library/LaunchDaemons/sh.deploy.agent.plist" with administrator privileges';
      checked(
        await this.run('/usr/bin/osascript', ['-e', script], { timeoutMs: 120000 }),
        'Remove older worker',
      );
      return this.status(true);
    });
  }
  async setEnabled(enabled) {
    return this.exclusive(async () => {
      const config = await this.config();
      if (!this.matching(config)) throw new Error('No worker for this coordinator was found.');
      const { computers } = await this.client.request('/api/v2/computers');
      const computer = computers.find((c) => c.nodeId === config.nodeId);
      if (!computer) throw new Error('This computer has not connected yet. Try again shortly.');
      const roles = computer.roles.filter((role) => role !== 'run-apps');
      if (enabled) roles.push('run-apps');
      await this.client.request(`/api/v2/computers/${encodeURIComponent(computer.id)}`, {
        method: 'PATCH',
        body: { roles },
      });
      // Admission only: never stop the service or existing apps when the switch is off.
      return this.status(true);
    });
  }
  status(force = false) {
    if (this.pendingStatus)
      return force ? this.pendingStatus.then(() => this.status(true)) : this.pendingStatus;
    if (!force && this.cachedAt !== undefined && this.now() - this.cachedAt < 15000)
      return Promise.resolve(this.last);
    this.pendingStatus = this.readStatus()
      .then((value) => {
        this.last = value;
        this.cachedAt = this.now();
        return value;
      })
      .finally(() => {
        this.pendingStatus = null;
      });
    return this.pendingStatus;
  }
  async readStatus() {
    const detected = await this.detect();
    let apps = this.last?.nodeId === detected.nodeId ? this.last?.apps || [] : [],
      computer,
      reachable = true;
    try {
      const [live, listing] = await Promise.all([
        this.client.request('/api/v2/live'),
        this.client.request('/api/v2/computers'),
      ]);
      computer = detected.nodeId
        ? listing.computers.find((c) => c.nodeId === detected.nodeId)
        : undefined;
      apps = detected.nodeId
        ? live.computers.find((c) => c.id === detected.nodeId)?.apps || []
        : [];
    } catch {
      reachable = false;
    }
    const state = !reachable
      ? 'cannot-reach-coordinator'
      : !detected.service.running
        ? 'service-stopped'
        : !detected.docker.answering
          ? 'docker-not-answering'
          : detected.nodeId && !computer?.online
            ? 'cannot-reach-coordinator'
            : 'running';
    if (state === 'docker-not-answering') this.dockerFailedAt ??= this.now();
    else if (detected.docker.answering) this.dockerFailedAt = undefined;
    const minutes = Math.floor((this.now() - (this.dockerFailedAt ?? this.now())) / 60000);
    const sentence =
      state === 'running'
        ? 'Docker is answering'
        : state === 'docker-not-answering'
          ? `Docker on this Mac has not answered${minutes ? ` for ${minutes} min` : ''}`
          : state === 'service-stopped'
            ? 'The worker on this Mac is not running'
            : 'This Mac cannot reach the coordinator';
    return {
      ...detected,
      state,
      sentence,
      apps,
      computer,
      enabled: computer?.roles.includes('run-apps') ?? detected.install !== 'none',
    };
  }
}
