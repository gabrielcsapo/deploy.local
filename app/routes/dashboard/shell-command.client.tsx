'use client';
import { Button, Toggle } from '@/components/ui';
export function ShellCommandCard({
  message,
  onChange,
}: {
  message: Record<string, any>;
  onChange: (input: Record<string, any>) => void;
}) {
  const s = message.shell;
  return (
    <section aria-label="Shell command" className="grid gap-2">
      <strong>Shell · {s.computer}</strong>
      <pre className="shell-command-output">$ {s.command}</pre>
      {s.agentRunning && (
        <p>Agent is running{s.status === 'running' ? '' : ' when command started'}</p>
      )}
      <pre className="shell-command-output" tabIndex={0} aria-label="Command output">
        {s.output || (s.status === 'running' ? 'Waiting for output…' : 'No output')}
      </pre>
      {s.truncated && <p>Output truncated; showing the last 64 KB.</p>}
      <p role="status">
        {s.status === 'running'
          ? 'Running'
          : `Exit ${s.code ?? 'unknown'} · ${(s.durationMs / 1000).toFixed(1)} seconds · ${s.reason}`}
      </p>
      {s.status === 'running' && (
        <Button onClick={() => onChange({ id: message.id, stop: true })}>Stop</Button>
      )}
      <p>Visibility applies to future agent turns; it cannot remove context already sent.</p>
      <Toggle
        label="Hide from agent"
        enabled={s.hidden}
        onChange={() => onChange({ id: message.id, hidden: !s.hidden })}
      />
    </section>
  );
}
