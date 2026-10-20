'use client';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';

export type ControlRequest = {
  id: string;
  kind: string;
  targetLabel: string;
  workerName: string;
  record?: boolean;
  expiresAt: number;
};

/** One client identity per tab, so the coordinator can tell controllers apart. */
const clientId = typeof crypto !== 'undefined' ? crypto.randomUUID() : 'web-client-id';

/**
 * An agent asked to drive a browser or window: answer it in the conversation, where the agent is
 * waiting, rather than in a panel the person has to find.
 */
export function ControlRequestCard({
  taskId,
  request,
  disabled,
  respond,
}: {
  taskId: string;
  request: ControlRequest;
  disabled: boolean;
  respond: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(action: 'approve' | 'deny') {
    setBusy(true);
    setError('');
    try {
      await respond(`/tasks/${taskId}/controls/${action}`, { clientId, requestId: request.id });
    } catch (e: any) {
      setError(e.message || 'The request could not be answered');
    } finally {
      setBusy(false);
    }
  }
  const minutes = Math.max(1, Math.round((request.expiresAt - Date.now()) / 60000));
  return (
    <section className="pw-question pw-control-request" aria-label="Agent control request">
      <div className="pw-question-heading">
        <WorkspaceIcon name="computer" />
        <span>Allow agent control?</span>
      </div>
      <p>
        <strong>{request.targetLabel}</strong> on {request.workerName}
        {request.record ? ', recorded' : ''}. The agent can click, type and scroll there, and its
        screenshots appear in this conversation. You can take control or stop at any time.
      </p>
      <p className="pw-control-request-meta">The request expires in about {minutes} min.</p>
      {error && <p role="alert">{error}</p>}
      <div className="pw-question-actions">
        <Button variant="link" disabled={disabled || busy} onClick={() => void act('deny')}>
          Not now
        </Button>
        <Button variant="primary" disabled={disabled || busy} onClick={() => void act('approve')}>
          {busy ? 'Allowing…' : 'Allow'}
        </Button>
      </div>
    </section>
  );
}
