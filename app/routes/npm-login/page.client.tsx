'use client';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner } from '@/components/ui';
import { api } from '../v2-public/api';
import '../v2-public/public.css';

type Login = {
  client: 'npm' | 'pnpm';
  computer: string;
  address: string;
  name: string;
  state: 'pending' | 'approved' | 'cancelled';
};

export default function NpmLogin() {
  const { pathname } = useLocation();
  return <SignIn key={pathname} pathname={pathname} />;
}

function SignIn({ pathname }: { pathname: string }) {
  const path = '/api/packages/npm-login/' + encodeURIComponent(pathname.split('/').pop()!);
  const [login, setLogin] = useState<Login>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function failed(error: Error & { status?: number }) {
    if (error.status === 401) {
      window.location.assign('/signin?returnTo=' + encodeURIComponent(pathname));
    } else if (error.status === 410) setExpired(true);
    else setError(error.message);
  }
  useEffect(() => {
    let active = true;
    void api<Login>(path).then(
      (value) => active && setLogin(value),
      (error) => active && failed(error),
    );
    return () => {
      active = false;
    };
  }, [path]);
  async function finish(action: 'approve' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      setLogin(await api<Login>(path, { action }));
    } catch (error) {
      failed(error as Error & { status?: number });
    } finally {
      setBusy(false);
    }
  }
  const client = login?.client ?? 'npm';
  return (
    <main
      className="dl-sheet v2-public v2-public-center v2-public-signin"
      style={{ paddingBottom: 96 }}
    >
      <div className="v2-public-stack">
        <div className="v2-public-brand">
          <span className="dl-mark">d</span>
          <span className="dl-strong">deploy.local</span>
        </div>
        {expired ? (
          <p role="status">This sign-in has expired. Run {client} login again.</p>
        ) : login?.state === 'cancelled' ? (
          <p role="status">Cancelled. Nothing changed.</p>
        ) : login?.state === 'approved' ? (
          <>
            <div className="v2-public-heading" role="status">
              <h1 className="dl-title">{client} is signed in</h1>
              <span className="dl-soft">
                {client} on this computer can publish as {login.name}. You can close this tab.
              </span>
            </div>
            <div className="dl-meta v2-public-divider">
              Remove the key any time in{' '}
              <a className="dl-link" href="/dashboard/settings">
                Settings, under Package keys
              </a>
              .
            </div>
          </>
        ) : login ? (
          <>
            <div className="v2-public-heading">
              <h1 className="dl-title">Sign in {client}?</h1>
              <span className="dl-soft">
                {client} on {login.computer} at {login.address} asked to publish packages as{' '}
                {login.name}.
              </span>
            </div>
            <div className="v2-public-actions">
              <Action variant="primary" disabled={busy} onClick={() => void finish('approve')}>
                Sign in {client}
              </Action>
              <Action variant="quiet" disabled={busy} onClick={() => void finish('cancel')}>
                Cancel
              </Action>
            </div>
            <span className="dl-meta">
              {client} gets a publishing key named for that computer and address. Installing never
              needs one.
            </span>
            <div className="dl-meta v2-public-divider">
              Didn’t just run {client} login? Cancel, and nothing changes.
            </div>
          </>
        ) : null}
        {error && <Banner kind="danger" title={error} />}
      </div>
    </main>
  );
}
