'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  fetchDeployments as serverFetchDeployments,
  fetchDashboardAggregate as serverFetchAggregate,
  deleteDeployment as serverDeleteDeployment,
} from '../../actions/deployments';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WsEvent } from '../../hooks/useWebSocket';
import type { FleetTotals } from '../../components/dashboard/FleetStrip';
import type { AppCardData, Severity } from '../../components/dashboard/AppCard';
import { getAuth, setAuth, clearAuth } from './detail/shared';

interface Deployment {
  name: string;
  type: string;
  port: number;
  status: string;
  containerId: string;
  createdAt: string;
  updatedAt: string;
}

interface PerAppStat {
  name: string;
  status: string;
  severity: Severity;
  crashLooping: boolean;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  rps: number;
  errPct: number;
  p95: number;
  requestsLastMin: number;
}

interface Aggregate {
  totals: FleetTotals;
  perApp: PerAppStat[];
  /** Only present on WS-pushed aggregates (the metrics collector merges it
      in); undefined on the initial server-action fetch. */
  dockerReachable?: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  down: 0,
  degraded: 1,
  building: 2,
  healthy: 3,
  idle: 4,
};

const RPS_HISTORY_MAX = 36;

// ── Context ─────────────────────────────────────────────────────────────────

interface DashboardData {
  deployments: Deployment[];
  aggregate: Aggregate | null;
  cards: AppCardData[];
  problemApps: AppCardData[];
  loading: boolean;
  error: string;
  handleDelete: (name: string) => Promise<void>;
}

const DashboardDataCtx = createContext<DashboardData | null>(null);

export function useDashboardData(): DashboardData {
  const ctx = useContext(DashboardDataCtx);
  if (!ctx) {
    throw new Error(
      'useDashboardData must be used inside <DashboardDataShell>. Wrap the dashboard layout, not bare children.',
    );
  }
  return ctx;
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

  const isLogin = mode === 'login';
  return (
    <div className="relative min-h-[calc(100vh-3.5rem)] mesh-bg overflow-hidden flex items-center justify-center px-6 py-12">
      <div className="absolute inset-0 grid-bg opacity-30 pointer-events-none" aria-hidden />
      <div className="relative w-full max-w-md">
        {/* Brand mark + product framing — turns a bare login form into a
            real landing surface so first-time visitors land somewhere
            recognisable instead of a tiny card floating in dark space. */}
        <div className="flex flex-col items-center text-center mb-7">
          <span className="brand-mark mb-4" aria-hidden style={{ width: 28, height: 28 }} />
          <h1 className="text-xl font-semibold tracking-tight mb-1">
            {isLogin ? 'Sign in to deploy.local' : 'Create your operator account'}
          </h1>
          <p className="text-sm text-text-secondary">
            {isLogin
              ? 'Authenticate to view and manage deployments on this server.'
              : 'One account per operator. Required for the dashboard and the CLI.'}
          </p>
        </div>

        <div className="card p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label className="block">
              <span className="eyebrow mb-1.5 block">Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                required
                autoFocus
                autoComplete="username"
              />
            </label>
            <label className="block">
              <span className="eyebrow mb-1.5 block">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                required
                autoComplete={isLogin ? 'current-password' : 'new-password'}
              />
            </label>
            {error && (
              <p className="text-xs text-danger bg-danger/10 ring-1 ring-danger/30 rounded-md px-2.5 py-1.5">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary mt-1" disabled={loading}>
              {loading ? 'Loading…' : isLogin ? 'Sign in' : 'Register'}
            </button>
          </form>
          <p className="text-xs text-text-tertiary mt-4 text-center">
            {isLogin ? (
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

        <p className="text-center text-[11px] font-mono text-text-tertiary/70 mt-5">
          Your server. Your account. No cloud round-trip.
        </p>
      </div>
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

/**
 * Wraps every authenticated dashboard route. Owns the WebSocket subscription,
 * fleet aggregate state, deployments list, and rolling RPS history so the
 * Overview/Apps/Activity sub-routes can each render their slice without
 * reopening a connection or re-fetching the same data.
 *
 * Children render only after sign-in; otherwise the LoginForm is mounted in
 * place. Sign-out is reactive via the storage event so the header dropdown
 * still works.
 */
export function DashboardDataShell({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [aggregate, setAggregate] = useState<Aggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const rpsHistoryRef = useRef<Map<string, number[]>>(new Map());
  const [historyTick, setHistoryTick] = useState(0);

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

  const fetchAggregate = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = (await serverFetchAggregate(auth.username, auth.token)) as Aggregate;
      setAggregate(data);
      for (const app of data.perApp) {
        const buf = rpsHistoryRef.current.get(app.name) ?? [];
        if (buf.length === 0) {
          rpsHistoryRef.current.set(app.name, [app.rps]);
        }
      }
    } catch {
      // best-effort — live WS updates will fill it in
    }
  }, []);

  // First-mount: read auth from localStorage. We start with `authed === null`
  // so the layout doesn't briefly flash the login form for signed-in users
  // while the cookie/localStorage check resolves.
  useEffect(() => {
    const auth = getAuth();
    if (auth) {
      setAuthed(true);
      fetchDeployments();
      fetchAggregate();
    } else {
      setAuthed(false);
      setLoading(false);
    }
  }, [fetchDeployments, fetchAggregate]);

  // React to sign-out from header profile dropdown
  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === 'deploy-sh-auth') {
        const auth = getAuth();
        if (!auth) {
          setAuthed(false);
          setDeployments([]);
          setAggregate(null);
        }
      }
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const channels = useMemo(() => (authed ? ['deployments'] : []), [authed]);
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === 'dashboard:aggregate') {
        const agg = event.data as unknown as Aggregate;
        setAggregate(agg);
        for (const app of agg.perApp) {
          const buf = rpsHistoryRef.current.get(app.name) ?? [];
          buf.push(app.rps);
          if (buf.length > RPS_HISTORY_MAX) buf.shift();
          rpsHistoryRef.current.set(app.name, buf);
        }
        const liveNames = new Set(agg.perApp.map((a) => a.name));
        for (const name of rpsHistoryRef.current.keys()) {
          if (!liveNames.has(name)) rpsHistoryRef.current.delete(name);
        }
        setHistoryTick((t) => t + 1);
      } else if (event.type === 'deployment:status') {
        setDeployments((prev) =>
          prev.map((d) =>
            d.name === event.deploymentName ? { ...d, status: event.data.status as string } : d,
          ),
        );
      } else if (event.type === 'deployment:created') {
        fetchDeployments();
        fetchAggregate();
      } else if (event.type === 'deployment:deleted') {
        setDeployments((prev) => prev.filter((d) => d.name !== event.deploymentName));
        rpsHistoryRef.current.delete(event.deploymentName);
      }
    },
    [fetchDeployments, fetchAggregate],
  );
  useWebSocket(channels, handleWsEvent);

  const handleDelete = useCallback(async (name: string) => {
    try {
      const auth = getAuth();
      if (!auth) return;
      await serverDeleteDeployment(auth.username, auth.token, name);
      setDeployments((prev) => prev.filter((d) => d.name !== name));
      rpsHistoryRef.current.delete(name);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const statsByName = useMemo(() => {
    const m = new Map<string, PerAppStat>();
    if (aggregate) for (const a of aggregate.perApp) m.set(a.name, a);
    return m;
  }, [aggregate]);

  const cards: AppCardData[] = useMemo(() => {
    void historyTick;
    return deployments
      .map((d) => {
        const stat = statsByName.get(d.name);
        const severity: Severity = stat?.severity
          ? stat.severity
          : d.status === 'running'
            ? 'idle'
            : d.status === 'building' || d.status === 'starting' || d.status === 'uploading'
              ? 'building'
              : 'down';
        return {
          name: d.name,
          status: stat?.status ?? d.status,
          severity,
          crashLooping: stat?.crashLooping ?? false,
          cpuPercent: stat?.cpuPercent ?? 0,
          memUsageBytes: stat?.memUsageBytes ?? 0,
          memLimitBytes: stat?.memLimitBytes ?? 0,
          memPercent: stat?.memPercent ?? 0,
          rps: stat?.rps ?? 0,
          errPct: stat?.errPct ?? 0,
          p95: stat?.p95 ?? 0,
          requestsLastMin: stat?.requestsLastMin ?? 0,
          rpsHistory: rpsHistoryRef.current.get(d.name) ?? [],
        };
      })
      .sort((a, b) => {
        const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (sevDiff !== 0) return sevDiff;
        if (a.rps !== b.rps) return b.rps - a.rps;
        return a.name.localeCompare(b.name);
      });
  }, [deployments, statsByName, historyTick]);

  const problemApps = useMemo(
    () => cards.filter((c) => c.severity === 'down' || c.severity === 'degraded'),
    [cards],
  );

  if (authed === null) {
    // Render the real dashboard chrome with empty/loading data on both the
    // server and first client pass. This keeps navigation stable during the
    // auth check instead of replacing the whole page with "$ fetching".
    return (
      <DashboardDataCtx.Provider
        value={{
          deployments: [],
          aggregate: null,
          cards: [],
          problemApps: [],
          loading: true,
          error: '',
          handleDelete: async () => {},
        }}
      >
        {children}
      </DashboardDataCtx.Provider>
    );
  }
  if (!authed) {
    return (
      <LoginForm
        onLogin={() => {
          setAuthed(true);
          setLoading(true);
          fetchDeployments();
          fetchAggregate();
        }}
      />
    );
  }

  return (
    <DashboardDataCtx.Provider
      value={{
        deployments,
        aggregate,
        cards,
        problemApps,
        loading,
        error,
        handleDelete,
      }}
    >
      {aggregate?.dockerReachable === false && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/12 px-3 py-2 text-sm text-text"
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-danger animate-pulse"
            aria-hidden
          />
          <span className="font-semibold">Docker daemon unreachable.</span>
          <span className="text-text-tertiary">
            Containers keep running, but statuses and metrics are stale and deploys will fail until
            it's back.
          </span>
        </div>
      )}
      {children}
    </DashboardDataCtx.Provider>
  );
}
