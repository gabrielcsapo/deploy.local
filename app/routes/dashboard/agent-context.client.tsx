'use client';
import { useId, useState } from 'react';
import { relativeTime } from './task-activity-summary';
import { Button } from '@/components/ui';

type ContextRun = { agentContext?: string; agentContextAt?: string };
export function AgentContext({ run }: { run?: ContextRun }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  if (!run?.agentContext) return null;
  return (
    <div className="pw-agent-context">
      <Button
        variant="link"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        What the agent was told
      </Button>
      {run.agentContextAt && (
        <time dateTime={run.agentContextAt} title={new Date(run.agentContextAt).toLocaleString()}>
          {relativeTime(run.agentContextAt)}
        </time>
      )}
      <pre id={contentId} hidden={!expanded}>
        {run.agentContext}
      </pre>
    </div>
  );
}
