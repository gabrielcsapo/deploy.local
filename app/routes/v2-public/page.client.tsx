'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-flight-router/client';
import { appColor } from './app-color';
import { Action, Banner, Field, Group, Item, Status } from '@/components/ui';
import { setAuth } from '../dashboard/detail/shared';
import { api, passkeySignIn, trusted } from './client';
import { preferPasskey } from './auth-policy';
import { returnPath } from './return-path';
import './public.css';

export function Brand() {
  return (
    <a href="/" className="v2-public-brand">
      <span className="dl-mark">d</span>deploy.local
    </a>
  );
}
export function PublicFrame({
  children,
  signin = false,
}: {
  children: ReactNode;
  signin?: boolean;
}) {
  return (
    <main className={`dl-sheet v2-public v2-public-center ${signin ? 'v2-public-signin' : ''}`}>
      <div className="v2-public-stack">
        <Brand />
        {children}
      </div>
    </main>
  );
}
export function SignInForm({
  onDone,
  passwordFirst = false,
}: {
  onDone: () => void;
  passwordFirst?: boolean;
}) {
  const [password, usePassword] = useState(passwordFirst);
  const [hasPasskey, setPasskey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([api('/api/v2/auth/methods'), trusted()])
      .then(([methods, trust]) => setPasskey(preferPasskey(methods, trust)))
      .catch(() => {});
  }, []);
  async function signIn(form?: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      if (form) {
        const values = Object.fromEntries(new FormData(form));
        const result = await api('/api/login', values);
        setAuth(String(values.username), result.token);
      } else await passkeySignIn();
      onDone();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="v2-public-actions">
        {hasPasskey && !password ? (
          <>
            <Action variant="primary" loading={busy} onClick={() => void signIn()}>
              Sign in with a passkey
            </Action>
            <Action variant="quiet" onClick={() => usePassword(true)}>
              Use a password instead
            </Action>
            <p className="dl-meta">
              Your passkey comes from your phone, your password manager, or a security key.
            </p>
          </>
        ) : (
          <form
            className="v2-public-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(event.currentTarget);
            }}
          >
            <Field name="username" label="Username" autoComplete="username" required />
            <Field
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Action variant="primary" type="submit" loading={busy}>
              Sign in
            </Action>
            {hasPasskey && (
              <Action variant="quiet" onClick={() => usePassword(false)}>
                Use a passkey
              </Action>
            )}
          </form>
        )}
      </div>
      {error && <Banner kind="danger" title={error} />}
    </>
  );
}
function SignIn() {
  const [signedIn, setSignedIn] = useState(false);
  const [finished, setFinished] = useState('');
  const [error, setError] = useState('');
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const code = params.get('cli');
  const destination = returnPath(params.get('returnTo'));
  useEffect(() => {
    if (code)
      void api('/api/v2/auth/account')
        .then(() => setSignedIn(true))
        .catch(() => {});
  }, [code]);
  async function approve(approved: boolean) {
    try {
      await api('/api/v2/auth/cli/approve', { code, approved });
      setFinished(approved ? 'Signed in. Return to your terminal.' : 'Sign-in denied.');
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <PublicFrame signin>
      <div className="v2-public-heading">
        <h1 className="dl-title">{code ? 'Sign in to the CLI' : 'Sign in'}</h1>
        <span className="dl-soft">To deploy.local on SER.</span>
      </div>
      {finished ? (
        <p role="status">{finished}</p>
      ) : signedIn && code ? (
        <>
          <p>Approve only if this code matches the one in your terminal.</p>
          <code>{code}</code>
          <Action variant="primary" onClick={() => void approve(true)}>
            Approve sign-in
          </Action>
          <Action onClick={() => void approve(false)}>Deny</Action>
        </>
      ) : (
        <SignInForm
          onDone={() => (code ? setSignedIn(true) : window.location.assign(destination))}
        />
      )}
      {error && <Banner kind="danger" title={error} />}
      <div className="dl-meta v2-public-divider">
        Just opening an app?{' '}
        <a className="dl-link" href="/">
          Apps at home
        </a>
      </div>
    </PublicFrame>
  );
}
function Setup() {
  const [info, setInfo] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api('/api/v2/setup')
      .then(setInfo)
      .catch((error) => setError(error.message));
  }, []);
  async function submit(form: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      const result = await api('/api/v2/setup', Object.fromEntries(new FormData(form)));
      setAuth(result.username, result.token);
      window.location.assign('/dashboard');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PublicFrame>
      <div className="v2-public-heading">
        <h1 className="dl-title">Set up {info?.name || 'SER'}</h1>
        <span className="dl-soft">
          {info?.name || 'SER'} is running deploy.local. Create the first account; it owns
          everything here.
        </span>
      </div>
      {info?.needsSetup === false ? (
        <>
          <p>An account already exists.</p>
          <a className="dl-btn primary" href="/signin">
            Sign in
          </a>
        </>
      ) : (
        <>
          <Group>
            <Item
              title={info?.name || 'SER'}
              description="Coordinator"
              end={<Status>Ready</Status>}
            />
          </Group>
          <form
            className="v2-public-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(event.currentTarget);
            }}
          >
            <div>
              <Field
                label="Setup code from SER"
                name="code"
                autoComplete="one-time-code"
                required
              />
              <p className="dl-meta">Printed by the installer. It works once, for 30 minutes.</p>
            </div>
            <Field label="Your name" name="name" autoComplete="name" required />
            <Field
              label="Username"
              name="username"
              autoComplete="username"
              pattern="[a-zA-Z0-9_-]{1,64}"
              required
            />
            <div>
              <Field
                label="Password"
                name="password"
                type="password"
                minLength={12}
                autoComplete="new-password"
                required
              />
              <p className="dl-meta">At least 12 characters. It always works, on any device.</p>
            </div>
            <Action variant="primary" type="submit" loading={busy}>
              Create account
            </Action>
          </form>
          <span className="dl-meta">
            Next, your browser asks to trust SER's certificate. The fingerprint is the one the
            installer printed. Once it does, you can add a passkey.
          </span>
        </>
      )}
      {error && <Banner kind="danger" title={error} />}
    </PublicFrame>
  );
}
function AppsHome() {
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  useEffect(() => {
    void api('/api/v2/auth/account')
      .then(() => window.location.replace('/dashboard'))
      .catch(() => {});
    void api('/api/v2/apps-home')
      .then(setData)
      .catch((error) => setError(error.message));
  }, []);
  return (
    <main className="dl-sheet v2-public">
      <nav className="v2-apps-nav">
        <div>
          <Brand />
          <a className="dl-link" href="/docs">
            Docs
          </a>
          <a className="dl-link" href="/changelog">
            Changelog
          </a>
          <a className="dl-btn" href="/signin">
            Sign in
          </a>
        </div>
      </nav>
      <div className="v2-apps-content">
        <h1 className="dl-title">Apps at home</h1>
        <p className="dl-soft">
          {data?.server ? `Running on ${data.server}. ` : ''}Open them from any phone or computer on
          your home network.
        </p>
        <div className="v2-apps-grid">
          {data?.apps.map((app: any) => (
            <a className="v2-apps-card" key={app.name} href={app.address}>
              <span className={`dl-glyph v2-app-color-${appColor(app.name)}`}>
                {app.name[0].toUpperCase()}
              </span>
              <span>
                <strong>{app.name}</strong>
                <span className="dl-meta">{new URL(app.address).host}</span>
              </span>
            </a>
          ))}
        </div>
        {data?.apps.length === 0 && (
          <p className="dl-soft">No apps are shared with everyone at home yet.</p>
        )}
        {error && <Banner kind="danger" title={error} />}
        <Banner
          kind="neutral"
          title="First time on this device? Trust SER’s certificate once, so apps open without a warning."
        >
          <a className="dl-link" href="/ca.crt">
            Set up this device
          </a>
        </Banner>
        <p className="dl-meta">Apps only for you are not shown here. Sign in to see them.</p>
      </div>
    </main>
  );
}
function Recover() {
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  useEffect(() => {
    const read = () =>
      api('/api/v2/setup/recovery')
        .then(setData)
        .catch((error) => setError(error.message));
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <PublicFrame>
      <div className="v2-public-heading">
        <h1 className="dl-title">Recovering SER</h1>
        <span className="dl-soft">
          {data?.summary || 'Follow the recovery started by the installer on SER.'}
        </span>
      </div>
      {data?.projects?.length > 0 && (
        <Group title="Projects">
          {data.projects.map((project: any) => (
            <Item
              key={project.name}
              title={project.name}
              description={project.detail}
              end={<Status>{project.status}</Status>}
            />
          ))}
        </Group>
      )}
      {data?.state === 'idle' && (
        <p className="dl-soft">
          No recovery is running. Start the installer on the replacement computer and choose
          Recover.
        </p>
      )}
      {error && <Banner kind="danger" title={error} />}
      <a className="dl-btn primary" href="/signin">
        Sign in
      </a>
    </PublicFrame>
  );
}
export default function PublicPage() {
  const { pathname } = useLocation();
  return pathname === '/setup' ? (
    <Setup />
  ) : pathname === '/recover' ? (
    <Recover />
  ) : pathname === '/signin' ? (
    <SignIn />
  ) : (
    <AppsHome />
  );
}
