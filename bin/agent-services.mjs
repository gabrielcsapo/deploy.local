import {
  existsSync,
  writeFileSync,
  rmSync,
  realpathSync,
  statSync,
  linkSync,
  renameSync,
  copyFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentConfigPath } from './agent-enrollment.mjs';
import { agentUser, ownUserFile, taskWorkerUser, userDirectory } from './agent-user.mjs';
import {
  servicePath as sharedServicePath,
  discoverProviderPaths,
} from '../desktop/src/worker-path.mjs';
export { discoverProviderPaths };

/**
 * `agent` is the supervised execution agent service. It runs whenever any role does, because it
 * is what reports `selfUpdate` and receives update jobs; `apps` says whether it may run app jobs.
 */
export function servicePlan(roles) {
  const apps = roles?.deploy ?? true,
    worker = roles?.tasks ?? false;
  return { agent: apps || worker, worker, apps };
}
/** Only the execution agent's connected supervisor child can accept self-update jobs. */
export function agentHeartbeatCapabilities(capabilities, roles, runtime = process) {
  return {
    ...capabilities,
    selfUpdate: runtime.env.DEPLOY_WORKER_CHILD && runtime.connected ? 1 : undefined,
    runApps: servicePlan(roles).apps ? undefined : 0,
  };
}
/** With Deploy apps off, the agent only keeps this computer's own build current. */
export function assertAgentJobAllowed(job, roles) {
  if (roles?.deploy === false && job?.type !== 'self-update')
    throw new Error('Deploy apps is off on this computer.');
}
/**
 * Remove an app's containers and networks from this computer, then look again. `docker rm -f`
 * exits 0 for a missing container on newer Docker and a failed listing looks like an empty one, so
 * neither exit code says the app is gone. Only a successful listing with nothing in it does.
 */
export function removeAgentDockerObjects({ deploymentName, applicationId, docker }) {
  const labels = [`deploy-sh.app=${deploymentName}`];
  if (applicationId) labels.push(`deploy-sh.app-id=${applicationId}`);
  const list = (args) => {
    const result = docker(args);
    if (result.status !== 0)
      throw new Error(`docker ${args[0]} failed: ${(result.stderr || '').trim() || 'no output'}`);
    return (result.stdout || '').trim().split('\n').filter(Boolean);
  };
  const legacy = `deploy-sh-${deploymentName.toLowerCase()}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const containers = () => [
    ...new Set([
      ...labels.flatMap((label) =>
        list(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}']),
      ),
      ...list([
        'ps',
        '-a',
        '--filter',
        `name=^/${legacy}(-prev-[0-9]+)?$`,
        '--format',
        '{{.Names}}',
      ]),
    ]),
  ];
  const networks = () => [
    ...new Set(
      labels.flatMap((label) =>
        list(['network', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}']),
      ),
    ),
  ];
  const removeAll = (find, command) => {
    const found = find();
    if (found.length === 0) return;
    const removal = docker([...command, ...found]);
    const still = find();
    if (still.length > 0)
      throw new Error(
        `Could not remove ${still.join(', ')}: ${(removal.stderr || '').trim() || 'no output'}`,
      );
  };
  removeAll(containers, ['rm', '-f']);
  removeAll(networks, ['network', 'rm']);
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
const executableNames = [
  { executable: 'deploy-worker', supervisor: 'deploy-worker-supervisor' },
  // Older Linux installs. On macOS `worker` is the task worker's state directory.
  { executable: 'worker', supervisor: 'worker-supervisor' },
];
export const WORKER_APP_ID = 'local.deploy.worker';
/**
 * macOS Local Network privacy blocks bare executables that launchd starts, so on a Mac the
 * worker build lives in an app bundle. DEPLOY_WORKER_APP moves it (tests, other volumes).
 */
export function workerAppPath(env = process.env, home = agentUser().home) {
  return env.DEPLOY_WORKER_APP
    ? resolve(env.DEPLOY_WORKER_APP)
    : join(home, 'Applications/deploy.local Worker.app');
}
/**
 * The coordinator's worker build, the supervisor's copy of it and where an update keeps the
 * build it replaced. A directory is never an executable: new Linux installs use names that
 * cannot clash with workerRoot, and older ones keep their regular-file `worker`.
 */
export function workerExecutablePaths(
  agentDir,
  {
    fileExists = isFile,
    platform = process.platform,
    app = platform === 'darwin' ? workerAppPath() : null,
  } = {},
) {
  if (platform === 'darwin') {
    const macos = join(app, 'Contents/MacOS');
    return {
      app,
      executable: join(macos, 'deploy-worker'),
      supervisor: join(macos, 'deploy-worker-supervisor'),
      // Outside the bundle: an old main executable in Contents/MacOS fails the bundle's seal.
      previous: join(agentDir, 'deploy-worker-app.previous'),
    };
  }
  const [current, legacy] = executableNames.map((names) => ({
    app: null,
    executable: join(agentDir, names.executable),
    supervisor: join(agentDir, names.supervisor),
    previous: join(agentDir, `${names.executable}.previous`),
  }));
  return !fileExists(current.executable) && fileExists(legacy.executable) ? legacy : current;
}
function samePath(left, right) {
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
/** The worker build a supervisor runs, or null when this process is not a supervisor. */
export function supervisedExecutable(execPath, agentDir, options = {}) {
  const { fileExists = isFile, platform = process.platform } = options;
  const pairs = executableNames.map((names) => ({
    supervisor: join(agentDir, names.supervisor),
    executable: join(agentDir, names.executable),
  }));
  if (platform === 'darwin') pairs.unshift(workerExecutablePaths(agentDir, options));
  for (const { supervisor, executable } of pairs)
    if (samePath(execPath, supervisor)) return fileExists(executable) ? executable : null;
  return null;
}
/**
 * The execution agent runs the supervisor, which is never replaced while it runs; the task
 * worker runs the swappable build so a restart after an update picks up the new one. `self`
 * runs this deploy command.
 */
export function serviceProgramArguments({ agentDir, self, ...options }) {
  const fileExists = options.fileExists ?? isFile;
  const { executable, supervisor } = workerExecutablePaths(agentDir, options);
  const worker = fileExists(executable) ? [executable] : self;
  return { agent: fileExists(supervisor) ? [supervisor] : worker, worker };
}
const xmlText = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function workerAppInfoPlist({ minimumVersion = '14.0' } = {}) {
  const entries = {
    CFBundleIdentifier: WORKER_APP_ID,
    CFBundleExecutable: 'deploy-worker',
    CFBundlePackageType: 'APPL',
    CFBundleName: 'deploy.local Worker',
    CFBundleDisplayName: 'deploy.local Worker',
    LSMinimumSystemVersion: minimumVersion,
    NSLocalNetworkUsageDescription:
      'deploy.local Worker connects to your deploy.local coordinator on this network to run coding tasks and build jobs.',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(entries)
  .map(([key, value]) => `<key>${key}</key><string>${xmlText(value)}</string>`)
  .join('\n')}
<key>LSUIElement</key><true/>
</dict></plist>
`;
}
/**
 * Seal the worker app so macOS lets it reach the coordinator. The supervisor is a separate
 * copy signed with the app's identifier first; then the bundle is re-signed and verified.
 * Call after anything in Contents/MacOS changes. `signSupervisor: false` leaves a running
 * supervisor alone; `ifNeeded` only seals a bundle that fails verification.
 */
export function sealWorkerBundle(
  app,
  { run = spawnSync, signSupervisor = true, ifNeeded = false } = {},
) {
  const codesign = (args, action) =>
    checked(run('codesign', args, { encoding: 'utf8' }), `Worker app ${action}`);
  const verify = ['--verify', '--strict', '--deep', app];
  if (ifNeeded && run('codesign', verify, { encoding: 'utf8' }).status === 0) return false;
  const macos = join(app, 'Contents/MacOS'),
    plist = join(app, 'Contents/Info.plist'),
    supervisor = join(macos, 'deploy-worker-supervisor');
  mkdirSync(macos, { recursive: true });
  if (!existsSync(plist)) writeFileSync(plist, workerAppInfoPlist());
  // An interrupted install can leave its staged copy behind, which the seal would reject.
  for (const name of readdirSync(macos))
    if (/^deploy-worker(-supervisor)?\.stage-\d+$/.test(name)) rmSync(join(macos, name));
  if (signSupervisor && isFile(supervisor))
    codesign(
      ['--force', '--sign', '-', '--identifier', WORKER_APP_ID, supervisor],
      'supervisor signing',
    );
  codesign(['--force', '--sign', '-', app], 'signing');
  codesign(verify, 'verification');
  return true;
}
/**
 * Give the supervisor the current build. Only call while (re)installing the agent service,
 * which restarts it. On Linux a hard link; on macOS a signed copy inside the sealed app.
 */
export function linkWorkerSupervisor(agentDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const { app, executable, supervisor } = workerExecutablePaths(agentDir, options);
  if (!isFile(executable)) return null;
  if (platform === 'darwin') {
    const staged = `${supervisor}.stage-${process.pid}`;
    rmSync(staged, { force: true });
    copyFileSync(executable, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, supervisor);
    sealWorkerBundle(app, { run: options.run });
    return supervisor;
  }
  if (existsSync(supervisor) && statSync(supervisor).ino === statSync(executable).ino)
    return supervisor;
  const staged = `${supervisor}.link-${process.pid}`;
  rmSync(staged, { force: true });
  linkSync(executable, staged);
  renameSync(staged, supervisor);
  return supervisor;
}
/** Once the Mac's worker app is in place, the bare builds an earlier install left are unused. */
export function removeBareWorkers(agentDir) {
  const names = ['deploy-worker', 'deploy-worker-supervisor', 'deploy-worker.previous'];
  // `<agentDir>/worker` is the task state directory unless an old install put a build there.
  if (isFile(join(agentDir, 'worker')))
    names.push('worker', 'worker-supervisor', 'worker.previous');
  return names.filter((name) => {
    if (!isFile(join(agentDir, name))) return false;
    rmSync(join(agentDir, name));
    return true;
  });
}
/** A Mac that ran apps kept its build at `<agentDir>/worker`, where task state now lives. */
export function moveClashingWorker(agentDir, root) {
  const [current, legacy] = executableNames;
  const from = (name) => join(agentDir, name);
  if (resolve(root) !== from(legacy.executable) || !isFile(from(legacy.executable))) return false;
  if (existsSync(from(current.executable)))
    throw new Error(`${from(current.executable)} already exists; remove it and retry.`);
  for (const [name, next] of [
    [`${legacy.executable}.previous`, `${current.executable}.previous`],
    [legacy.supervisor, current.supervisor],
    [legacy.executable, current.executable],
  ])
    if (isFile(from(name)) && !existsSync(from(next))) renameSync(from(name), from(next));
  return true;
}
export function workerRoot(platform = process.platform, home = agentUser().home) {
  return join(
    home,
    platform === 'darwin' ? 'Library/Application Support' : '.local/share',
    'deploy.local/worker',
  );
}
export function servicePath(
  providerPaths = [],
  environmentPath = process.env.PATH || '',
  home = agentUser().home,
) {
  return sharedServicePath(providerPaths, environmentPath, home);
}
const xml = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function workerPlist({ args, root, configPath, logPath, path }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>sh.deploy.worker</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Interactive</string>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${xml(path)}</string>
<key>DEPLOY_AGENT_CONFIG</key><string>${xml(configPath)}</string>
<key>NODE_USE_SYSTEM_CA</key><string>1</string>
</dict>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}
// systemd expands specifiers even inside quotes; ExecStart also expands dollar signs.
export function systemdQuote(value, exec = false) {
  let text = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  if (exec) text = text.replaceAll('$', () => '$$');
  return `"${text}"`;
}
export function workerUnit({ args, root, configPath, path }) {
  return `[Unit]
Description=deploy.local task worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.map((arg) => systemdQuote(arg, true)).join(' ')}
WorkingDirectory=${systemdQuote(root)}
Restart=always
RestartSec=5
Environment=${systemdQuote(`PATH=${path}`)}
Environment=${systemdQuote(`DEPLOY_AGENT_CONFIG=${configPath}`)}
Environment=NODE_USE_SYSTEM_CA=1

[Install]
WantedBy=default.target
`;
}
export function workerServiceFile(user = agentUser(), platform = process.platform) {
  return platform === 'darwin'
    ? join(user.home, 'Library/LaunchAgents/sh.deploy.worker.plist')
    : join(user.home, '.config/systemd/user/deploy-local-worker.service');
}
function userSystemctl(args, user = agentUser(), run = spawnSync) {
  const environment = [
    `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user.uid}/bus`,
  ];
  return user.name
    ? run('sudo', ['-u', user.name, 'env', ...environment, 'systemctl', '--user', ...args], {
        encoding: 'utf8',
      })
    : run('systemctl', ['--user', ...args], { encoding: 'utf8' });
}
function checked(result, action) {
  if (result.status !== 0)
    throw new Error(
      `${action} failed. ${String(result.stderr || result.error?.message || '').trim()}`,
    );
}
export function installWorkerService(programArguments) {
  const user = agentUser();
  if (user.uid === 0)
    throw new Error(
      'The task worker must run as a login user. On Linux use sudo from that login when Deploy apps is enabled.',
    );
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Worker services require macOS or Linux.');
  const root = workerRoot(),
    file = workerServiceFile(user);
  userDirectory(root, user);
  userDirectory(dirname(file), user);
  const logPath = join(user.home, 'Library/Logs/deploy.local/worker.log');
  if (process.platform === 'darwin') userDirectory(dirname(logPath), user);
  const options = {
    args: [...programArguments, 'worker', 'run'],
    root,
    configPath: agentConfigPath(),
    logPath,
    path: servicePath(discoverProviderPaths(), process.env.PATH, user.home),
  };
  writeFileSync(file, process.platform === 'darwin' ? workerPlist(options) : workerUnit(options), {
    mode: 0o600,
  });
  ownUserFile(file, user);
  if (process.platform === 'darwin') {
    const domain = `gui/${user.uid}`,
      target = `${domain}/sh.deploy.worker`;
    spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
    let loaded;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
      loaded = spawnSync('launchctl', ['bootstrap', domain, file], { encoding: 'utf8' });
      if (loaded.status === 0) break;
      // KeepAlive can briefly retain the old process during a repair.
      spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
      spawnSync('launchctl', ['bootout', domain, file], { stdio: 'ignore' });
    }
    checked(loaded, 'Worker launchd bootstrap (retry agent install from your normal login)');
    checked(
      spawnSync('launchctl', ['kickstart', '-k', target], { encoding: 'utf8' }),
      'Worker launchd start',
    );
  } else {
    checked(userSystemctl(['daemon-reload'], user), 'User systemd reload');
    checked(
      userSystemctl(['enable', '--now', 'deploy-local-worker.service'], user),
      'User worker enable (ensure the login user has a systemd session)',
    );
    checked(userSystemctl(['restart', 'deploy-local-worker.service'], user), 'User worker restart');
  }
}
/** After a confirmed update, restart the task worker so it runs the new build too. */
export function restartWorkerService({
  platform = process.platform,
  user = taskWorkerUser(),
  exists = existsSync,
  run = spawnSync,
} = {}) {
  if (!exists(workerServiceFile(user, platform))) return false;
  checked(
    platform === 'darwin'
      ? run('launchctl', ['kickstart', '-k', `gui/${user.uid}/sh.deploy.worker`], {
          encoding: 'utf8',
        })
      : userSystemctl(['restart', 'deploy-local-worker.service'], user, run),
    'Task worker restart',
  );
  return true;
}
export function installedServices() {
  const agentFile =
    process.platform === 'darwin'
      ? resolve(agentUser().home, 'Library/LaunchAgents/sh.deploy.agent.plist')
      : '/etc/systemd/system/deploy-local-agent.service';
  return Object.fromEntries(
    [
      ['agent', agentFile],
      ['worker', workerServiceFile()],
    ].map(([name, file]) => {
      const installed = existsSync(file);
      const result = !installed
        ? null
        : process.platform === 'darwin'
          ? spawnSync('launchctl', ['print', `gui/${agentUser().uid}/sh.deploy.${name}`], {
              encoding: 'utf8',
            })
          : name === 'worker'
            ? userSystemctl(['is-active', '--quiet', 'deploy-local-worker.service'])
            : spawnSync('systemctl', ['is-active', '--quiet', 'deploy-local-agent.service']);
      const running =
        installed &&
        result?.status === 0 &&
        (process.platform !== 'darwin' || /state = running\b/.test(result.stdout || ''));
      return [name, { installed, running }];
    }),
  );
}
export function uninstallServices() {
  if (process.platform === 'darwin') {
    for (const name of ['agent', 'worker']) {
      const file = resolve(agentUser().home, `Library/LaunchAgents/sh.deploy.${name}.plist`);
      if (!existsSync(file)) continue;
      const target = `gui/${agentUser().uid}/sh.deploy.${name}`;
      spawnSync('launchctl', ['bootout', target], { encoding: 'utf8' });
      const retained = spawnSync('launchctl', ['print', target], { stdio: 'ignore' });
      if (retained.status === 0)
        throw new Error(`Could not stop ${name}; credentials kept. Retry agent uninstall.`);
      rmSync(file);
    }
  } else if (process.platform === 'linux') {
    const agent = '/etc/systemd/system/deploy-local-agent.service';
    if (existsSync(agent)) {
      if (process.getuid?.() !== 0)
        throw new Error('Use sudo to remove the execution agent system service.');
      checked(
        spawnSync('systemctl', ['disable', '--now', 'deploy-local-agent.service'], {
          encoding: 'utf8',
        }),
        'Execution agent stop',
      );
      rmSync(agent);
      checked(
        spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8' }),
        'System systemd reload',
      );
    }
    const worker = workerServiceFile();
    if (existsSync(worker)) {
      checked(
        userSystemctl(['disable', '--now', 'deploy-local-worker.service']),
        'User worker stop',
      );
      rmSync(worker);
      checked(userSystemctl(['daemon-reload']), 'User systemd reload');
    }
  }
}
