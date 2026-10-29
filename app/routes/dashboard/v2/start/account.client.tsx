'use client';
import { formatTime } from '../data/time';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Action, Banner, Dialog, Field, Group, Item } from '@/components/ui';
import { useLocation } from 'react-flight-router/client';
import { api, addPasskey, trusted } from '../../../v2-public/client';
import { offerPasskey } from '../../../v2-public/auth-policy';
import { SignInForm } from '../../../v2-public/page.client';
import '../../../v2-public/public.css';
import './start.css';
import SshKeysSettings from '../../ssh-keys.client';
import { SettingsFrame } from '../settings/frame.client';

export function PasskeyOffer({ onChange }: { onChange?: () => void }) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    void Promise.all([trusted(), api('/api/v2/auth/account')])
      .then(async ([trust, info]) => {
        if (!mounted || !offerPasskey(info, trust)) return;
        await api('/api/v2/auth/account', { passkeyOffered: true });
        if (mounted) setVisible(true);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  async function act(add: boolean) {
    setBusy(true);
    setError('');
    try {
      if (add) await addPasskey();
      await api('/api/v2/auth/account', { passkeyOffered: true });
      setVisible(false);
      onChange?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!visible) return null;
  return (
    <div className="v2-passkey-offer">
      <Banner
        kind="neutral"
        title="This browser now trusts SER, so you can sign in with a passkey instead of your password."
        action={
          <>
            <Action variant="quiet" disabled={busy} onClick={() => void act(false)}>
              Not now
            </Action>
            <Action variant="primary" loading={busy} onClick={() => void act(true)}>
              Add a passkey
            </Action>
          </>
        }
      />
      {error && <Banner kind="danger" title={error} />}
    </div>
  );
}
export function SessionExpired({ initiallyExpired = false }: { initiallyExpired?: boolean }) {
  const [expired, setExpired] = useState(initiallyExpired);
  const [password, setPassword] = useState(false);
  useEffect(() => {
    // The probe catches expiry while preserving the mounted page and unsent drafts.
    const check = () =>
      api('/api/v2/auth/account').catch((error) => {
        if (error.status === 401) setExpired(true);
      });
    const listener = () => void check();
    window.addEventListener('deploy:session-expired', listener);
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('deploy:session-expired', listener);
    };
  }, []);
  return (
    <Dialog open={expired} title="Sign in again" onClose={() => {}}>
      <p className="dl-soft">
        This browser was signed out after 30 days. After you sign in, you come back to this task.
      </p>
      <SignInForm
        key={String(password)}
        passwordFirst={password}
        onDone={() => {
          setExpired(false);
          window.dispatchEvent(new Event('deploy:session-restored'));
        }}
      />
      <Action variant="quiet" onClick={() => setPassword(true)}>
        Use a password
      </Action>
    </Dialog>
  );
}
function Devices() {
  const [items, setItems] = useState<any[]>([]);
  const [pair, setPair] = useState<any>();
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => api('/api/v2/devices').then((data) => setItems(data.devices));
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pair) return;
    const timer = setTimeout(
      () => {
        setPair(undefined);
        setQr('');
      },
      Math.max(0, pair.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pair]);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/api/v2/devices/pair', {});
      setQr(await QRCode.toDataURL(JSON.stringify(result), { width: 320, margin: 2 }));
      setPair(result);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/v2/devices/${encodeURIComponent(id)}`, {}, 'DELETE');
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <SettingsFrame>
      <Group title="Paired devices">
        {items.map((item) => (
          <Item
            key={item.id}
            title={item.name}
            description={`Added ${formatTime(item.createdAt)}`}
            end={<Action onClick={() => void remove(item.id)}>Remove</Action>}
          />
        ))}
        {!items.length && <Item title="No paired devices yet" />}
      </Group>
      <Action variant="primary" loading={busy} onClick={() => void create()}>
        Add iPhone
      </Action>
      {pair && (
        <div className="v2-public-stack">
          <h2 className="dl-title">Scan with your iPhone</h2>
          <p className="dl-soft">
            The code carries SER's address, its certificate and a one-time sign-in, so there is
            nothing to type or check.
          </p>
          <img className="v2-pair-qr" src={qr} alt="One-time iPhone pairing code" />
          <p className="dl-meta">Works once. Expires in five minutes. Keep this code private.</p>
        </div>
      )}
      {error && <Banner kind="danger" title={error} />}
    </SettingsFrame>
  );
}
function Account() {
  const [info, setInfo] = useState<any>();
  const [message, setMessage] = useState('');
  const [canAdd, setCanAdd] = useState(false);
  useEffect(() => {
    void trusted().then(setCanAdd);
    void api('/api/v2/auth/account')
      .then(setInfo)
      .catch((error) => setMessage(error.message));
  }, []);
  return (
    <SettingsFrame>
      <Group>
        <Item title={info?.name || 'Account'} description={info?.username} />
        <Item
          title="Add iPhone"
          description="Pair with a one-time QR code"
          href="/dashboard/settings/devices"
        />
      </Group>
      <PasskeyOffer
        onChange={() => {
          void api('/api/v2/auth/account')
            .then(setInfo)
            .catch((error) => setMessage(error.message));
        }}
      />
      {canAdd && info?.passkeyOffered && !info.hasPasskey && (
        <Action
          onClick={() =>
            void addPasskey()
              .then(() => api('/api/v2/auth/account'))
              .then(setInfo)
              .catch((error) => setMessage(error.message))
          }
        >
          Add a passkey
        </Action>
      )}
      {info?.hasPasskey && (
        <p className="dl-soft">A passkey is ready. Your password always works.</p>
      )}
      <form
        className="v2-public-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          void api('/api/user/password', Object.fromEntries(new FormData(form)))
            .then(() => {
              form.reset();
              setMessage('Password changed.');
            })
            .catch((error) => setMessage(error.message));
        }}
      >
        <Field
          name="currentPassword"
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <Action type="submit">Change password</Action>
      </form>
      {message && <p role="status">{message}</p>}
      <section className="dl-section" id="ssh-keys">
        <h2 className="dl-section-title">SSH keys</h2>
        <SshKeysSettings />
      </section>
    </SettingsFrame>
  );
}
export default function AccountPage() {
  const { pathname } = useLocation();
  return pathname.endsWith('/devices') ? <Devices /> : <Account />;
}
