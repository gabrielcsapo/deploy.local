'use client';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui';
import { useBrowserOrigin, type Overview } from './data';
import { cloneAddresses } from './clone.ts';
export { archiveLabel } from './clone.ts';
import './clone.css';

export type Protocol = 'https' | 'ssh';
const REMEMBERED = 'deploy.clone-protocol';
export const SSH_KEYS_PAGE = '/dashboard/settings/account#ssh-keys';

function CopyAddress({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const said =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again.' : label;
  return (
    <button
      type="button"
      className="dl-btn secondary v2-clone-copy"
      aria-label={said}
      title={said}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/** HTTPS or SSH, remembered across the Clone menu, Overview and the push commands. */
export function useCloneProtocol(ssh: string | null) {
  const [chosen, setChosen] = useState<Protocol>('https');
  useEffect(() => {
    try {
      if (localStorage.getItem(REMEMBERED) === 'ssh') setChosen('ssh');
    } catch {
      // Without storage the choice starts on HTTPS.
    }
  }, []);
  const choose = (next: Protocol) => {
    setChosen(next);
    try {
      localStorage.setItem(REMEMBERED, next);
    } catch {
      // Remembering the choice is a convenience.
    }
  };
  const shown: Protocol = chosen === 'ssh' && ssh ? 'ssh' : 'https';
  return { shown, choose };
}

/** The HTTPS and SSH tabs; shown only when this server runs SSH. */
export function CloneTabs({
  shown,
  choose,
  label,
}: {
  shown: Protocol;
  choose: (next: Protocol) => void;
  label: string;
}) {
  return (
    <div className="v2-clone-tabs" role="tablist" aria-label={label}>
      {(['https', 'ssh'] as const).map((protocol) => (
        <button
          key={protocol}
          type="button"
          role="tab"
          aria-selected={shown === protocol}
          className={shown === protocol ? 'on' : undefined}
          onClick={() => choose(protocol)}
        >
          {protocol === 'ssh' ? 'SSH' : 'HTTPS'}
        </button>
      ))}
    </div>
  );
}

/** Which key SSH uses, linked to where keys are added. */
export function SshKeyHint() {
  return (
    <>
      Uses an SSH key you added in{' '}
      <a href={SSH_KEYS_PAGE} className="dl-link">
        SSH keys
      </a>
      .
    </>
  );
}

/** HTTPS and SSH tabs over one address with a copy button, as in the Code menu and Overview. */
export function CloneUrls({
  repository,
  projectId,
}: {
  repository: NonNullable<Overview['repository']>;
  projectId: string;
}) {
  const origin = useBrowserOrigin();
  const { https, ssh } = cloneAddresses(repository, projectId, origin);
  const { shown, choose } = useCloneProtocol(ssh);
  const address = shown === 'ssh' ? ssh! : https;
  const name = shown === 'ssh' ? 'SSH' : 'HTTPS';
  return (
    <>
      {ssh && <CloneTabs shown={shown} choose={choose} label="Clone with" />}
      <div className="v2-clone-row">
        <label className="dl-field">
          <input
            className="dl-mono"
            aria-label={`${name} clone URL`}
            readOnly
            value={address}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <CopyAddress value={address} label={`Copy ${name} URL`} />
      </div>
      <p className="v2-clone-hint">
        {shown === 'ssh' ? <SshKeyHint /> : 'Signs in with your deploy.local account.'}
      </p>
    </>
  );
}
