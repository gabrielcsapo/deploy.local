'use client';
import { useState } from 'react';
import { ActionCluster, CopyButton, OverflowMenu, IconButton } from '@/components/ui';

type Row = Record<string, any>;
export function ReplyActions({ message, run }: { message: Row; run?: Row }) {
  const [contextOpen, setContextOpen] = useState(false);
  const timestamp = message.createdAt ? new Date(message.createdAt).toLocaleString() : '';
  const link =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/dashboard?task=${encodeURIComponent(message.taskId)}#message-${encodeURIComponent(message.id)}`;
  return (
    <div className="pw-reply-actions" title={timestamp || undefined}>
      <ActionCluster>
        <CopyButton label="Copy reply" text={message.content} size="compact" />
        <OverflowMenu label="More reply actions">
          {run?.agentContext && (
            <button data-dismiss-menu onClick={() => setContextOpen(true)}>
              What the agent was told
            </button>
          )}
          <CopyButton label="Copy link to message" text={link} menuItem />
          {timestamp && <time dateTime={message.createdAt}>{timestamp}</time>}
        </OverflowMenu>
      </ActionCluster>
      {contextOpen && (
        <section className="pw-reply-context" aria-label="What the agent was told">
          <header>
            <strong>What the agent was told</strong>
            <IconButton
              icon="close"
              label="Close agent context"
              onClick={() => setContextOpen(false)}
            />
          </header>
          <pre>{run?.agentContext}</pre>
        </section>
      )}
    </div>
  );
}
