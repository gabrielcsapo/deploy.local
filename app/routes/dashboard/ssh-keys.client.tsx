'use client';
import { useEffect, useId, useState } from 'react';
import { Action, Banner, Dialog, Field, Group, Icon, Item, Skeleton } from '@/components/ui';
import { useDataSeed, freshSeed } from './v2/data/seeds';
import { useProjectFormatting } from './v2/projects/formatting';
import { useBrowserOrigin } from './v2/projects/data';
import { getAuth } from './detail/shared';
import './ssh-keys.css';
import { keyNameFromComment, shortFingerprint } from './ssh-keys.ts';

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
  const response = await fetch('/api/ssh-keys' + path, {
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
function CopyText({
  value,
  label,
  children,
}: {
  value: string;
  label: string;
  children?: React.ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const said =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again.' : label;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return children ? (
    <button type="button" className="dl-btn quiet" onClick={copy} aria-label={said}>
      {state === 'copied' ? 'Copied' : children}
    </button>
  ) : (
    <button type="button" className="dl-icon-btn sm" onClick={copy} aria-label={said} title={said}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
    </button>
  );
}

function AddKeyDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const form = useId();
  const keyField = useId();
  const [publicKey, setPublicKey] = useState('');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const command = 'pbcopy < ~/.ssh/id_ed25519.pub';
  const close = () => {
    setPublicKey('');
    setName('');
    setNamed(false);
    setError('');
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add an SSH key"
      className="v2-ssh-add"
      actions={
        <>
          <Action onClick={close}>Cancel</Action>
          <Action variant="primary" type="submit" form={form} loading={busy}>
            Add key
          </Action>
        </>
      }
    >
      <form
        id={form}
        className="v2-ssh-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (/PRIVATE KEY/.test(publicKey)) {
            setError('That is a private key. Paste the public key, the .pub file, instead.');
            return;
          }
          setBusy(true);
          setError('');
          void sshKeyRequest('', { name: name.trim(), publicKey: publicKey.trim() })
            .then(async () => {
              await onAdded();
              close();
            })
            .catch((failure) => setError((failure as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="v2-ssh-step">
          <span className="dl-field-label">1. Copy this computer's public key</span>
          <div className="v2-ssh-command">
            <pre className="dl-term">{command}</pre>
            <CopyText value={command} label="Copy command" />
          </div>
          <p className="dl-meta">
            On Linux or Windows, open that file and copy its one line. No key yet? Run{' '}
            <span className="dl-mono">ssh-keygen -t ed25519</span> first.
          </p>
        </div>
        <div className="v2-ssh-step">
          <label className="dl-field-label" htmlFor={keyField}>
            2. Paste it here
          </label>
          <textarea
            id={keyField}
            className={`dl-textarea v2-ssh-key${error ? ' invalid' : ''}`}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="ssh-ed25519 AAAA… you@computer"
            value={publicKey}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setPublicKey(next);
              setError('');
              if (!named) setName(keyNameFromComment(next));
            }}
          />
          {error ? (
            <p className="dl-field-error">{error}</p>
          ) : (
            <span className="dl-hint">
              Public keys start with ssh-ed25519, ecdsa-sha2 or ssh-rsa. Never paste the private
              key.
            </span>
          )}
        </div>
        <div className="v2-ssh-step">
          <Field
            label="Name"
            maxLength={80}
            value={name}
            placeholder="MacBook Pro"
            onChange={(event) => {
              setName(event.target.value);
              setNamed(true);
            }}
          />
          <span className="dl-hint">Name it after the computer the key is on.</span>
        </div>
      </form>
    </Dialog>
  );
}

export default function SshKeysSettings() {
  const seed = useDataSeed();
  const { localeDate, repositoryTime } = useProjectFormatting();
  const [data, setData] = useState<KeySettings | undefined>(
    () => seed?.data['/api/ssh-keys'] as KeySettings | undefined,
  );
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Key | null>(null);
  async function refresh() {
    try {
      setData(await sshKeyRequest());
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  useEffect(() => {
    if (!freshSeed(seed, '/api/ssh-keys')) void refresh();
  }, [seed]);
  // The page's own host name, read the same way on the server and while hydrating.
  const origin = useBrowserOrigin();
  const host = origin ? new URL(origin).hostname : 'deploy.local';
  const port = data?.server.port;
  const address = port ? `ssh://git@${host}${port === 22 ? '' : `:${port}`}` : '';
  const added = (at: string) => localeDate(at, { month: 'short', day: 'numeric' });
  return (
    <div className="v2-ssh-keys">
      {error && (
        <Banner title={error} action={<Action onClick={() => void refresh()}>Retry</Action>} />
      )}
      {!data ? (
        <Skeleton rows={3} />
      ) : (
        <>
          <Group
            title="Keys"
            end={
              <Action variant="quiet" onClick={() => setAdding(true)}>
                Add key
              </Action>
            }
          >
            {data.keys.map((key) => (
              <Item
                key={key.id}
                lead={<Icon name="key" />}
                title={key.name}
                description={
                  <span title={key.fingerprint}>
                    {key.type} · {shortFingerprint(key.fingerprint)} · added {added(key.createdAt)}
                  </span>
                }
                end={key.lastUsedAt ? `Used ${repositoryTime(key.lastUsedAt)}` : 'Never used'}
              >
                <Action variant="quiet" disabled={busy} onClick={() => setRemoving(key)}>
                  Remove
                </Action>
              </Item>
            ))}
            {!data.keys.length && (
              <Item
                lead={<Icon name="key" />}
                title="No SSH keys yet"
                description="Add this computer's key to clone and push over SSH."
              />
            )}
          </Group>
          <div>
            <Group title="This server">
              {data.server.enabled && port ? (
                <>
                  <Item
                    lead={<Icon name="server" />}
                    title="Address"
                    description={<span className="dl-mono">{address}</span>}
                  >
                    <CopyText value={address} label="Copy SSH address" />
                  </Item>
                  {data.server.hostFingerprints.map((fingerprint) => (
                    <Item
                      key={fingerprint}
                      lead={<Icon name="key" />}
                      title="Host fingerprint"
                      description={<span className="dl-mono v2-ssh-wrap">{fingerprint}</span>}
                    >
                      {data.server.knownHostsLine && (
                        <CopyText value={data.server.knownHostsLine} label="Copy known_hosts line">
                          Copy known_hosts line
                        </CopyText>
                      )}
                    </Item>
                  ))}
                </>
              ) : (
                <Item
                  lead={<Icon name="server" />}
                  title="SSH is off on this server"
                  description="Clone over HTTPS for now. Whoever runs this server can turn SSH on with DEPLOY_SSH_PORT."
                />
              )}
            </Group>
            {data.server.enabled && port && (
              <p className="v2-ssh-note">
                The first time you connect, SSH asks whether to trust {host}. Say yes only if the
                fingerprint it shows matches this one, or add the known_hosts line to skip the
                question.
              </p>
            )}
          </div>
        </>
      )}
      <AddKeyDialog open={adding} onClose={() => setAdding(false)} onAdded={refresh} />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this SSH key?"
        actions={
          <>
            <Action onClick={() => setRemoving(null)}>Cancel</Action>
            <Action
              variant="danger"
              onClick={() => {
                const key = removing;
                setRemoving(null);
                if (!key) return;
                setBusy(true);
                void sshKeyRequest(`/${key.id}/delete`, {})
                  .then(refresh)
                  .catch((failure) => setError((failure as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              Remove key
            </Action>
          </>
        }
      >
        <p>“{removing?.name}” will no longer be able to clone or push over SSH.</p>
      </Dialog>
    </div>
  );
}
