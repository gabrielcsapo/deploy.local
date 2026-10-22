'use client';
import { useEffect, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { Button, IconButton } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';
import { getAuth } from './detail/shared';
import { taskRisks, type RiskComputer, type RiskPermission } from './task-risk';

export function useTaskRisks(workerId?: string, permissions: RiskPermission[] = []) {
  const [computers, setComputers] = useState<RiskComputer[]>([]);
  useEffect(() => {
    if (!workerId) return;
    const controller = new AbortController();
    const load = async () => {
      const auth = getAuth();
      if (!auth) {
        setComputers([]);
        return;
      }
      try {
        const response = await fetch('/api/computers', {
          headers: { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Computer inventory unavailable');
        const value = await response.json();
        if (!controller.signal.aborted) setComputers(value.computers);
      } catch {
        if (!controller.signal.aborted) setComputers([]);
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [workerId]);
  const computer = computers.find((c) => c.workerIds.includes(workerId ?? ''));
  return { computer, risks: taskRisks(computer, permissions) };
}
export function RiskChips({ computer, risks }: ReturnType<typeof useTaskRisks>) {
  return (
    <>
      {computer &&
        risks.map((risk) => (
          <Link
            key={risk.id}
            className="pw-risk-chip"
            title={risk.explanation}
            to={`/dashboard/computers#computer/${encodeURIComponent(computer.id)}`}
          >
            <WorkspaceIcon name={risk.icon} />
            {risk.label}
          </Link>
        ))}
    </>
  );
}
export function RiskNotice({ risks }: Pick<ReturnType<typeof useTaskRisks>, 'risks'>) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('deploy:risk-notice-dismissed') === 'true';
    } catch {
      return false;
    }
  });
  function dismiss() {
    try {
      localStorage.setItem('deploy:risk-notice-dismissed', 'true');
    } catch {}
    setDismissed(true);
  }
  if (dismissed || !risks.length) return null;
  return (
    <aside className="pw-risk-notice" aria-label="Computer access notice">
      <IconButton icon="close" label="Dismiss computer access notice" onClick={dismiss} />
      <strong>Agent access is on</strong>
      <p>{risks.map((risk) => risk.explanation).join(' ')}</p>
      <footer>
        <Button
          variant="link"
          onClick={() => {
            try {
              localStorage.setItem('deploy:risk-notice-dismissed', 'true');
            } catch {}
            setDismissed(true);
          }}
        >
          Don't show again
        </Button>
        <Link to="/docs/architecture#computer-access">Learn more</Link>
      </footer>
    </aside>
  );
}
