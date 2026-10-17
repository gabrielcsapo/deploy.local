'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, TextField, Select, ErrorBanner, LoadingState } from '@/components/ui';
import { getAuth } from './detail/shared';

type Connection = {
  provider: string;
  enabled: boolean;
  mode: string;
  baseUrl: string;
  model: string;
  billingMode: string;
  hasKey: boolean;
  revision: string;
};
type Worker = {
  configurationFailed?: boolean;
  id: string;
  name: string;
  heartbeat: string;
  connections: Connection[];
  providerStatus: Array<{ provider: string; revision: string; status: string }>;
  login: { status: string; expiresAt: number; verificationUrl?: string; userCode?: string } | null;
};
async function request(path: string, body?: object) {
  const auth = getAuth();
  if (!auth) throw new Error('Sign in to manage providers');
  const response = await fetch('/api/workspace' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Provider settings unavailable');
  return value;
}
export default function ProviderSettings() {
  const [data, setData] = useState<{
    managed: {
      available: boolean;
      reason: string;
      workerId: string | null;
      status: string;
      error: string;
    };
    workers: Worker[];
  }>();
  const [workerId, setWorkerId] = useState(''),
    [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  async function refresh() {
    try {
      setData(await request('/provider-connections'));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  const worker =
    data?.workers.find((value) => value.id === (workerId || data.managed.workerId)) ||
    data?.workers[0];
  return (
    <div className="ds-provider-settings">
      {error && (
        <ErrorBanner
          message={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      {!data ? (
        <LoadingState />
      ) : (
        <>
          <div className="ds-provider-worker">
            <div>
              <strong>Task worker</strong>
              <p className="text-text-secondary">
                {data.managed.status === 'online'
                  ? 'Online'
                  : data.managed.status === 'starting'
                    ? 'Starting…'
                    : 'Start a worker to run coding tasks on this computer.'}
              </p>
            </div>
            <Button
              variant="primary"
              disabled={
                starting ||
                data.managed.status === 'online' ||
                data.managed.status === 'starting' ||
                !data.managed.available
              }
              onClick={async () => {
                setStarting(true);
                try {
                  await request('/workers/managed/start', {});
                  await refresh();
                } catch (failure) {
                  setError((failure as Error).message);
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting
                ? 'Starting…'
                : data.managed.status === 'online'
                  ? 'Worker running'
                  : 'Start task worker'}
            </Button>
          </div>
          {data.managed.reason && <p className="text-text-secondary">{data.managed.reason}</p>}
          {data.managed.error && <ErrorBanner message={data.managed.error} />}
          {worker && (
            <>
              {worker.configurationFailed && (
                <ErrorBanner message="The worker could not apply its provider connection. Check the connection settings and installed provider runtime." />
              )}
              <label className="ui-field">
                <span className="ui-field-label">Task computer</span>
                <Select value={worker.id} onChange={(event) => setWorkerId(event.target.value)}>
                  {data.workers.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name} ·{' '}
                      {Date.now() - Date.parse(value.heartbeat) < 10000 ? 'Online' : 'Offline'}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="text-text-secondary">
                Connections apply to new runs on this computer. Saved keys are never shown again.
              </p>
              {worker.connections.map((connection) => (
                <ConnectionForm
                  key={worker.id + connection.provider}
                  worker={worker}
                  connection={connection}
                  refresh={refresh}
                />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
function ConnectionForm({
  worker,
  connection,
  refresh,
}: {
  worker: Worker;
  connection: Connection;
  refresh: () => Promise<void>;
}) {
  const [value, setValue] = useState(connection),
    [key, setKey] = useState(''),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (!dirty) setValue(connection);
  }, [connection, dirty]);
  const change = (patch: Partial<Connection>) => {
    setValue({ ...value, ...patch });
    setDirty(true);
    setMessage('');
  };
  const name = { codex: 'Codex', claude: 'Claude', compatible: 'Local or compatible API' }[
    connection.provider
  ];
  const login = worker.login;
  const report = worker.providerStatus.find((item) => item.provider === connection.provider);
  const online = Date.now() - Date.parse(worker.heartbeat) < 10000;
  const status = !online
    ? 'Worker offline'
    : report?.revision !== connection.revision
      ? 'Applying…'
      : {
          'signed-in': 'Signed in',
          configured: 'Configured',
          'signed-out': 'Sign-in required',
          'not-installed': 'Not installed',
          disabled: 'Disabled',
        }[report?.status || ''] || 'Checking…';
  async function save(event: FormEvent, clearKey = false) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request('/provider-connections', {
        ...value,
        workerId: worker.id,
        apiKey: key,
        clearKey,
      });
      setKey('');
      setDirty(false);
      setMessage('Saved. The worker applies this before its next run.');
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ds-provider-connection" aria-label={`${name} connection`}>
      <header>
        <h3>{name}</h3>
        <span className="text-text-secondary">{status}</span>
      </header>
      <form onSubmit={save} className="ds-provider-form">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          Enable {name}
        </label>
        {connection.provider !== 'compatible' ? (
          <label className="ui-field">
            <span className="ui-field-label">Authentication</span>
            <Select value={value.mode} onChange={(event) => change({ mode: event.target.value })}>
              <option value="account">Worker account</option>
              <option value="api-key">API key</option>
            </Select>
          </label>
        ) : (
          <>
            <TextField
              label="API base URL"
              type="url"
              value={value.baseUrl}
              onChange={(event) => change({ baseUrl: event.target.value })}
              placeholder="http://127.0.0.1:11434/v1"
              required={value.enabled}
            />
            <TextField
              label="Model"
              value={value.model}
              onChange={(event) => change({ model: event.target.value })}
              required={value.enabled}
            />
            <label className="ui-field">
              <span className="ui-field-label">Billing</span>
              <Select
                value={value.billingMode}
                onChange={(event) => change({ billingMode: event.target.value })}
              >
                <option value="local">Local inference</option>
                <option value="api">API usage</option>
              </Select>
            </label>
          </>
        )}
        {(value.mode === 'api-key' || connection.provider === 'compatible') && (
          <TextField
            label={connection.hasKey ? 'Replace API key' : 'API key'}
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setDirty(true);
            }}
            placeholder={
              connection.hasKey
                ? 'Leave blank to keep saved key'
                : connection.provider === 'compatible'
                  ? 'Optional for local inference'
                  : ''
            }
          />
        )}
        {connection.provider === 'codex' && value.mode === 'account' && (
          <Button
            disabled={
              !online ||
              busy ||
              ((login?.status === 'requested' || login?.status === 'pending') &&
                login.expiresAt > Date.now())
            }
            onClick={async () => {
              setError('');
              try {
                await request('/provider-connections/login', { workerId: worker.id });
                await refresh();
              } catch (failure) {
                setError((failure as Error).message);
              }
            }}
          >
            Sign in with ChatGPT
          </Button>
        )}
        {connection.provider === 'claude' && value.mode === 'account' && (
          <p className="text-text-secondary">
            Uses the worker’s existing Claude sign-in. Choose API key to connect from here.
          </p>
        )}
        {connection.provider === 'codex' && login && login.expiresAt > Date.now() && (
          <div role="status">
            {login.status === 'pending' && login.verificationUrl && login.userCode ? (
              <>
                <a href={login.verificationUrl} target="_blank" rel="noreferrer" className="btn">
                  Continue sign-in
                </a>
                <p>
                  Enter code <code>{login.userCode}</code> in the provider’s sign-in page.
                </p>
              </>
            ) : login.status === 'requested' ? (
              'Preparing sign-in…'
            ) : login.status === 'succeeded' ? (
              'Signed in.'
            ) : login.status === 'failed' ? (
              'Sign-in did not complete. Try again.'
            ) : (
              ''
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save connection'}
          </Button>
        </div>
        {message && (
          <p role="status" className="text-text-secondary">
            {message}
          </p>
        )}
        {error && <ErrorBanner message={error} />}
      </form>
    </section>
  );
}
