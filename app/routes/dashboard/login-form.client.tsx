'use client';

import { useState } from 'react';
import { BrandMark } from '../../components/BrandLogo';
import { setAuth } from './detail/shared';

/** The password sign-in form, shown where a page needs an account before it can do anything. */
export function LoginForm({ onLogin }: { onLogin: () => void }) {
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
    <div className="dashboard-shell ds-auth min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="relative w-full max-w-md">
        {/* Brand mark + product framing — turns a bare login form into a
            real landing surface so first-time visitors land somewhere
            recognisable instead of a tiny card floating in dark space. */}
        <div className="flex flex-col items-center text-center mb-7">
          <BrandMark className="mb-4 size-7" />
          <h1 className="text-xl font-semibold tracking-tight mb-1">
            {isLogin ? 'Sign in to deploy.local' : 'Create your account'}
          </h1>
          <p className="text-sm text-text-secondary">
            {isLogin
              ? 'Your projects, tasks, and computers in one place.'
              : 'Connect to your workspace on this server.'}
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
              <p
                role="alert"
                className="text-xs text-danger bg-danger/10 ring-1 ring-danger/30 rounded-md px-2.5 py-1.5"
              >
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

        <p className="text-center text-caption font-mono text-text-tertiary/70 mt-5">
          Your server. Your account. No cloud round-trip.
        </p>
      </div>
    </div>
  );
}
