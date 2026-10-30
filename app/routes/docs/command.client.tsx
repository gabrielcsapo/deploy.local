'use client';
import { useState } from 'react';
import { Icon } from '../../components/ui/v2/shared';

/** A labelled one-line command with a copy button, matching the About page's install command. */
export function DocsCommand({ label, command }: { label: string; command: string }) {
  const [status, setStatus] = useState('');
  return (
    <div className="docs-v2-command">
      <span className="dl-meta">{label}</span>
      <div>
        <code>{command}</code>
        <button
          type="button"
          className="dl-icon-btn"
          aria-label={`Copy ${label} command`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
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
      <span role="status" className={status ? 'dl-meta' : 'docs-v2-sr-only'}>
        {status}
      </span>
    </div>
  );
}
