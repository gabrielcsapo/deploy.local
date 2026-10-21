import { existsSync, writeFileSync, rmSync, realpathSync, accessSync, constants } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentConfigPath } from './agent-enrollment.mjs';
import { agentUser, ownUserFile, userDirectory } from './agent-user.mjs';

export function servicePlan(roles) {
  return { agent: roles?.deploy ?? true, worker: roles?.tasks ?? false };
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
  return [
    ...new Set([
      ...providerPaths.filter(Boolean).map((path) => dirname(path)),
      join(home, '.local/bin'),
      join(home, '.npm-global/bin'),
      join(home, '.cargo/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      ...environmentPath.split(delimiter).filter((path) => path.startsWith('/')),
    ]),
  ].join(':');
}
export function discoverProviderPaths(path = process.env.PATH || '') {
  return ['codex', 'claude'].flatMap((name) => {
    const candidate = path
      .split(delimiter)
      .filter((dir) => dir.startsWith('/'))
      .map((dir) => join(dir, name))
      .find((file) => {
        try {
          accessSync(file, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    // Keep both a shim's directory and its real installation directory available.
    return candidate ? [candidate, realpathSync(candidate)] : [];
  });
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
function userSystemctl(args, user = agentUser()) {
  const environment = [
    `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user.uid}/bus`,
  ];
  return user.name
    ? spawnSync('sudo', ['-u', user.name, 'env', ...environment, 'systemctl', '--user', ...args], {
        encoding: 'utf8',
      })
    : spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
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
