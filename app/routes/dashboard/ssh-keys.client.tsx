'use client';
import { useEffect, useState } from 'react';
import {
  Button,
  TextField,
  TextArea,
  CopyButton,
  ConfirmDialog,
  LoadingState,
  ErrorBanner,
} from '@/components/ui';
import { getAuth } from './detail/shared';

type Key = {
  id: string;
  name: string;
  type: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
};
type KeySettings = {
  keys: Key[];
  server: {
    enabled: boolean;
    port: number | null;
    hostFingerprints: string[];
    knownHostsLine: string;
  };
};
export async function sshKeyRequest(path = '', body?: object): Promise<any> {
  const auth = getAuth();
  if (!auth) throw new Error('Sign in to manage SSH keys');
  const response = await fetch('/api/workspace/ssh-keys' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'SSH keys unavailable');
  return result;
}
export default function SshKeysSettings() {
  const [data, setData] = useState<KeySettings>();
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Key | null>(null);
  async function refresh() {
    try {
      setData(await sshKeyRequest());
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="min-w-0 space-y-4">
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
          {data.keys.length === 0 && (
            <p className="text-sm text-text-secondary">
              No SSH keys yet. Add this computer’s public key to clone and push repositories.
            </p>
          )}
          {data.keys.map((key) => (
            <div key={key.id} className="min-w-0 space-y-2 border-b border-border pb-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="min-w-0 break-words">{key.name}</strong>
                <Button variant="danger" disabled={busy} onClick={() => setDeleting(key)}>
                  Delete
                </Button>
              </div>
              <p className="text-sm text-text-secondary">{key.type}</p>
              <p className="font-mono text-xs break-all">{key.fingerprint}</p>
              <p className="text-xs text-text-secondary">
                Added {new Date(key.createdAt).toLocaleDateString()} · Last used{' '}
                {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
              </p>
            </div>
          ))}
          <form
            className="min-w-0 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setFormError('');
              if (/PRIVATE KEY/.test(publicKey)) {
                setFormError('Paste your public key (.pub file), never your private key.');
                return;
              }
              setBusy(true);
              void sshKeyRequest('', { name, publicKey })
                .then(async () => {
                  setName('');
                  setPublicKey('');
                  await refresh();
                })
                .catch((failure) => setFormError(failure.message))
                .finally(() => setBusy(false));
            }}
          >
            <TextField
              label="Key name (optional)"
              maxLength={80}
              value={name}
              placeholder="Defaults to the key comment"
              onChange={(event) => setName(event.target.value)}
            />
            <TextArea
              label="Public key"
              value={publicKey}
              required
              spellCheck={false}
              autoComplete="off"
              placeholder="ssh-ed25519 AAAA… computer"
              error={formError}
              onChange={(event) => {
                setPublicKey(event.target.value);
                setFormError('');
              }}
            />
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Add SSH key'}
            </Button>
          </form>
          <section aria-label="Connect" className="min-w-0 space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">Connect</h3>
            {data.server.enabled ? (
              <>
                <p className="text-sm text-text-secondary">
                  Compare this host fingerprint before trusting deploy.local, or copy the line below
                  into ~/.ssh/known_hosts.
                </p>
                {data.server.hostFingerprints.map((fingerprint) => (
                  <p key={fingerprint} className="font-mono text-xs break-all">
                    {fingerprint}
                  </p>
                ))}
                <div className="flex min-w-0 items-end gap-2">
                  <TextField
                    className="min-w-0 flex-1"
                    label="known_hosts line"
                    readOnly
                    value={data.server.knownHostsLine}
                    onFocus={(event) => event.target.select()}
                  />
                  <CopyButton label="Copy known_hosts line" text={data.server.knownHostsLine} />
                </div>
                <p className="text-xs font-mono break-all">
                  git clone ssh://git@deploy.local:{data.server.port}/home-gym.git
                </p>
              </>
            ) : (
              <p className="text-sm text-text-secondary">
                SSH is unavailable. The server administrator can enable it with DEPLOY_SSH_PORT=2222
                and restart the control service.
              </p>
            )}
          </section>
        </>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete SSH key?"
        message={`“${deleting?.name || ''}” will no longer be able to open new SSH connections.`}
        confirmLabel="Delete key"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const key = deleting;
          setDeleting(null);
          if (!key) return;
          setBusy(true);
          void sshKeyRequest(`/${key.id}/delete`, {})
            .then(refresh)
            .catch((failure) => setError(failure.message))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
