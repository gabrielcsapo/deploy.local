'use client';
import { useState } from 'react';
import { Icon } from '../../../components/ui/v2/shared';
export const installCommand =
  'curl -fsSL https://github.com/gabrielcsapo/deploy.local/releases/latest/download/install.sh | sh';
export function InstallCommand() {
  const [status, setStatus] = useState('');
  return (
    <div className="public-install">
      <div className="public-command">
        <code>{installCommand}</code>
        <button
          type="button"
          className="dl-icon-btn"
          aria-label="Copy install command"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(installCommand);
              setStatus('Copied');
            } catch {
              setStatus('Could not copy. Select the command and copy it.');
            }
          }}
        >
          {status === 'Copied' ? (
            <Icon name="check" />
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          )}
        </button>
      </div>
      <span className="dl-meta">
        Run it on the computer that stays on. Needs Docker; macOS, Linux or Windows.
      </span>
      <span role="status" className={status ? 'dl-meta' : 'public-sr-only'}>
        {status}
      </span>
    </div>
  );
}
