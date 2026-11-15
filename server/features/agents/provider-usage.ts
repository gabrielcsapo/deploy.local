import { spawn, execFile } from 'node:child_process';

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
};
export type ProviderUsage = {
  id: string;
  name: string;
  status: 'loading' | 'signed-in' | 'signed-out' | 'unavailable';
  plan?: string;
  windows: UsageWindow[];
  checkedAt?: number;
};
const initial = (): ProviderUsage[] => [
  { id: 'codex', name: 'Codex', status: 'loading', windows: [] },
  { id: 'claude', name: 'Claude', status: 'loading', windows: [] },
];
let snapshot = initial();
let refreshing = false;
let refreshedAt = 0;
export function invalidateProviderUsage() {
  refreshedAt = 0;
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const shortText = (x: unknown) => (typeof x === 'string' ? x.slice(0, 100) : undefined);
function duration(minutes: unknown, fallback: string) {
  if (!finite(minutes) || minutes <= 0) return fallback;
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  return `${minutes} minutes`;
}
// Deliberately select quota fields; never forward account identities or credentials.
export function codexUsage(
  account: any,
  limits: any,
  checkedAt = Date.now() / 1000,
): ProviderUsage {
  const result: ProviderUsage = {
    id: 'codex',
    name: 'Codex',
    status: 'unavailable',
    windows: [],
    checkedAt,
  };
  if (!account || !('account' in account)) return result;
  if (!account.account) return { ...result, status: 'signed-out' };
  result.status = 'signed-in';
  result.plan = account.account.type === 'apiKey' ? 'API key' : shortText(account.account.planType);
  const buckets =
    limits?.rateLimitsByLimitId && Object.keys(limits.rateLimitsByLimitId).length
      ? Object.entries(limits.rateLimitsByLimitId)
      : limits?.rateLimits
        ? [['codex', limits.rateLimits]]
        : [];
  for (const [id, raw] of buckets.slice(0, 20)) {
    const bucket = raw as any;
    for (const key of ['primary', 'secondary']) {
      const window = bucket?.[key];
      if (!finite(window?.usedPercent)) continue;
      const label = duration(
        window.windowDurationMins,
        key === 'primary' ? 'Current' : 'Secondary',
      );
      result.windows.push({
        id: `${id}-${key}`,
        label: id === 'codex' ? label : `${shortText(bucket.limitName) || id} · ${label}`,
        usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        ...(finite(window.resetsAt) && window.resetsAt > 0 ? { resetsAt: window.resetsAt } : {}),
      });
    }
  }
  return result;
}
export function claudeUsage(auth: any, checkedAt = Date.now() / 1000): ProviderUsage {
  return {
    id: 'claude',
    name: 'Claude',
    checkedAt,
    windows: [],
    status:
      auth?.loggedIn === true
        ? 'signed-in'
        : auth?.loggedIn === false
          ? 'signed-out'
          : 'unavailable',
    plan: auth?.authMethod === 'api_key' ? 'API key' : shortText(auth?.subscriptionType),
  };
}
export function readCodexUsage(
  binary = process.env.DEPLOY_CODEX_BIN || 'codex',
  timeout = 10000,
): Promise<ProviderUsage> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false,
      buffer = '';
    let account: any, limits: any;
    const received = new Set<number>();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(codexUsage(account, limits));
    };
    const timer = setTimeout(finish, timeout);
    const send = (message: unknown) => {
      if (!settled) child.stdin.write(JSON.stringify(message) + '\n');
    };
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', finish);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (settled) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 0) {
            if (message.error) return finish();
            send({ method: 'initialized' });
            send({ method: 'account/read', id: 1, params: { refreshToken: false } });
            send({ method: 'account/rateLimits/read', id: 2 });
          }
          if (message.id === 1) {
            account = message.result;
            received.add(1);
          }
          if (message.id === 2) {
            limits = message.result;
            received.add(2);
          }
          if (received.size === 2) finish();
        } catch {
          /* Ignore non-protocol output. */
        }
      }
    });
    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'deploy_local_usage', version: '1.0.0' } },
    });
  });
}
function readClaudeUsage(): Promise<ProviderUsage> {
  return new Promise((resolve) => {
    execFile(
      process.env.DEPLOY_CLAUDE_BIN || 'claude',
      ['auth', 'status'],
      { timeout: 10000, maxBuffer: 65536 },
      (_error, stdout) => {
        try {
          resolve(claudeUsage(JSON.parse(stdout)));
        } catch {
          resolve(claudeUsage(null));
        }
      },
    );
  });
}
// Polling /state never blocks on provider processes. One read per minute per worker.
export function providerUsage(): ProviderUsage[] {
  if (!refreshing && Date.now() - refreshedAt >= 60000) {
    refreshing = true;
    void Promise.all([readCodexUsage(), readClaudeUsage()])
      .then((next) => {
        snapshot = next;
      })
      .finally(() => {
        refreshedAt = Date.now();
        refreshing = false;
      });
  }
  return snapshot;
}
// Remote registrations are untrusted: retain only the public, bounded display schema.
export function sanitizeProviderUsage(value: unknown): ProviderUsage[] {
  if (!Array.isArray(value)) return [];
  return ['codex', 'claude'].flatMap((id) => {
    const p = value.find((item) => item?.id === id);
    if (!p) return [];
    return [
      {
        id,
        name: id === 'codex' ? 'Codex' : 'Claude',
        status: ['loading', 'signed-in', 'signed-out', 'unavailable'].includes(p.status)
          ? p.status
          : 'unavailable',
        plan: shortText(p.plan),
        checkedAt: finite(p.checkedAt) ? p.checkedAt : undefined,
        windows:
          Array.isArray(p.windows) && p.status === 'signed-in'
            ? p.windows.slice(0, 40).flatMap((w: any, index: number) =>
                finite(w?.usedPercent)
                  ? [
                      {
                        id: String(index),
                        label: shortText(w.label) || 'Current',
                        usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
                        resetsAt: finite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt : undefined,
                      },
                    ]
                  : [],
              )
            : [],
      },
    ];
  });
}
