'use client';
import { useEffect, useState } from 'react';
import { CopyButton, SegmentedControl, TextField } from '@/components/ui';
import { sshKeyRequest } from './ssh-keys.client';

export function RepositoryClone({ repository }: { repository: Record<string, any> }) {
  const [transport, setTransport] = useState<'https' | 'ssh'>('https');
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);
  useEffect(() => {
    if (transport !== 'ssh') return;
    let mounted = true;
    void sshKeyRequest()
      .then((data) => {
        if (mounted) setHasKeys(data.keys.length > 0);
      })
      .catch(() => {
        if (mounted) setHasKeys(null);
      });
    return () => {
      mounted = false;
    };
  }, [transport]);
  const ssh = transport === 'ssh';
  const url =
    typeof window === 'undefined'
      ? ''
      : ssh
        ? repository.sshPort && repository.sshClonePath
          ? `ssh://git@${window.location.hostname}:${repository.sshPort}${repository.sshClonePath}`
          : ''
        : repository.clonePath
          ? window.location.origin + repository.clonePath
          : '';
  return (
    <div className="min-w-0 space-y-3">
      <SegmentedControl
        label="Clone protocol"
        value={transport}
        options={[
          { value: 'https', label: 'HTTPS' },
          { value: 'ssh', label: 'SSH' },
        ]}
        onChange={setTransport}
      />
      <div className="flex min-w-0 items-end gap-2">
        <TextField
          className="min-w-0 flex-1"
          label={`${ssh ? 'SSH' : 'HTTPS'} clone URL`}
          value={url}
          readOnly
          onFocus={(event) => event.target.select()}
        />
        <CopyButton label="Copy clone command" text={`git clone ${url}`} disabled={!url} />
      </div>
      {ssh ? (
        <p className="text-sm text-text-secondary">
          {!repository.sshPort
            ? 'SSH is unavailable on this server. '
            : hasKeys === false
              ? 'Add this computer’s SSH key to clone and push. '
              : 'Use an SSH key added to your account. '}
          <a className="underline" href="/dashboard/settings#settings-ssh-keys">
            Settings → SSH keys
          </a>
        </p>
      ) : (
        <p className="text-sm text-text-secondary">
          Use your deploy.local username and session token. Keep the token in your Git credential
          manager.
        </p>
      )}
    </div>
  );
}
