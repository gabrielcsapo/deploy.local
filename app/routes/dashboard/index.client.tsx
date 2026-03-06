'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-flight-router/client';
import {
  fetchDeployments as serverFetchDeployments,
  deleteDeployment as serverDeleteDeployment,
} from '../../actions/deployments';
import { getAuth, setAuth, clearAuth, appUrl, StatusBadge } from './detail/shared';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WsEvent } from '../../hooks/useWebSocket';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface Deployment {
  name: string;
  type: string;
  port: number;
  status: string;
  containerId: string;
  createdAt: string;
  updatedAt: string;
}

// ── Login form ──────────────────────────────────────────────────────────────

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'register' ? '/api/register' : '/api/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Request failed');
      setAuth(username, body.token);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-20">
      <div className="card p-6">
        <h2 className="text-sm font-semibold mb-4">
          {mode === 'login' ? 'Sign in to dashboard' : 'Create an account'}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
            required
            aria-label="Username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            required
            aria-label="Password"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading...' : mode === 'login' ? 'Sign in' : 'Register'}
          </button>
        </form>
        <p className="text-xs text-text-tertiary mt-3 text-center">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="text-accent hover:text-accent-hover"
                onClick={() => setMode('register')}
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                className="text-accent hover:text-accent-hover"
                onClick={() => setMode('login')}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Deployment list ─────────────────────────────────────────────────────────

function DeploymentList({
  deployments,
  onDelete,
}: {
  deployments: Deployment[];
  onDelete: (name: string) => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  if (deployments.length === 0) {
    return <EmptyState />;
  }

  return (
    <>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-tertiary">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Port</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Deployed</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deployments.map((d) => (
              <tr key={d.name} className="hover:bg-bg-hover transition-colors">
                <td className="px-4 py-3 font-medium">
                  <Link to={`/dashboard/${d.name}`} className="text-accent hover:text-accent-hover">
                    {d.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-text-secondary">{d.type}</td>
                <td className="px-4 py-3">
                  <a
                    href={appUrl(d.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:text-accent-hover font-mono text-xs"
                  >
                    {d.name}.local
                  </a>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={d.status} />
                </td>
                <td className="px-4 py-3 text-text-secondary text-xs">
                  {new Date(d.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <a
                      href={appUrl(d.name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-sm"
                    >
                      Open
                    </a>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteTarget(d.name)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Deployment"
        message={`Delete ${deleteTarget}?`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-12 text-center border-b border-border">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent/10 text-accent mb-4 text-lg">
          &#9650;
        </div>
        <h2 className="text-sm font-semibold mb-2">Deploy your first application</h2>
        <p className="text-sm text-text-secondary max-w-md mx-auto">
          Push a project from your terminal using the CLI. Check the{' '}
          <Link to="/docs" className="text-accent hover:text-accent-hover">
            docs
          </Link>{' '}
          for details.
        </p>
      </div>
      <div className="divide-y divide-border">
        <div className="px-6 py-4 flex gap-4">
          <div className="flex items-center justify-center w-6 h-6 rounded-full border border-border text-xs text-text-tertiary shrink-0 mt-0.5">
            1
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Deploy an example project</p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              <code className="text-xs font-mono bg-bg rounded px-2 py-1 text-text-secondary">
                cd examples/node && deploy
              </code>
              <code className="text-xs font-mono bg-bg rounded px-2 py-1 text-text-secondary">
                cd examples/static && deploy
              </code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function Component() {
  const [authed, setAuthed] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchDeployments = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = await serverFetchDeployments(auth.username, auth.token);
      setDeployments(data as Deployment[]);
      setError('');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Unauthorized')) {
        clearAuth();
        setAuthed(false);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const auth = getAuth();
    if (auth) {
      setAuthed(true);
      fetchDeployments();
    } else {
      setLoading(false);
    }
  }, [fetchDeployments]);

  // WebSocket for real-time deployment updates
  const channels = useMemo(() => (authed ? ['deployments'] : []), [authed]);
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === 'deployment:status') {
        setDeployments((prev) =>
          prev.map((d) =>
            d.name === event.deploymentName ? { ...d, status: event.data.status as string } : d,
          ),
        );
      } else if (event.type === 'deployment:created') {
        // Refetch full list to get complete deployment data
        fetchDeployments();
      } else if (event.type === 'deployment:deleted') {
        setDeployments((prev) => prev.filter((d) => d.name !== event.deploymentName));
      }
    },
    [fetchDeployments],
  );
  useWebSocket(channels, handleWsEvent);

  async function handleDelete(name: string) {
    try {
      const auth = getAuth();
      if (!auth) return;
      await serverDeleteDeployment(auth.username, auth.token, name);
      setDeployments((prev) => prev.filter((d) => d.name !== name));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleLogout() {
    const auth = getAuth();
    if (auth) {
      try {
        await fetch('/api/logout', {
          headers: {
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
        });
      } catch {
        // best-effort server-side logout
      }
    }
    clearAuth();
    setAuthed(false);
    setDeployments([]);
  }

  if (!authed) {
    return (
      <LoginForm
        onLogin={() => {
          setAuthed(true);
          setLoading(true);
          fetchDeployments();
        }}
      />
    );
  }

  const auth = getAuth();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Deployments</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-tertiary">{auth?.username}</span>
          <button type="button" className="btn btn-sm" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <LoadingState />
      ) : (
        <DeploymentList deployments={deployments} onDelete={handleDelete} />
      )}
    </div>
  );
}
