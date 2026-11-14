'use client';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action } from '@/components/ui';
import { api } from '../../../v2-public/api';
import { shouldShowFirstTask } from './first-task';
import './start.css';

import { useDataSeed, readSeeded } from '../data/seeds';
export function FirstTask() {
  const seed = useDataSeed();
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let mounted = true;
    setVisible(false);
    const taskId = pathname.match(/^\/dashboard\/tasks\/([^/]+)$/)?.[1];
    if (!taskId) return;
    void Promise.all([
      readSeeded(seed, '/api/auth/account', () => api('/api/auth/account')),
      readSeeded(seed, `/api/task-snapshots/${taskId}`, () => api(`/api/task-snapshots/${taskId}`)),
    ])
      .then(async ([account, task]) => {
        if (!mounted || !shouldShowFirstTask(account.firstTaskSeen, task.firstTask)) return;
        await api('/api/auth/account', { firstTaskSeen: true });
        if (mounted) setVisible(true);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [pathname, seed]);
  async function dismiss() {
    await api('/api/auth/account', { firstTaskSeen: true });
    setVisible(false);
  }
  return visible ? (
    <aside className="v2-first-task">
      <div className="v2-first-task-head">
        <strong>Your first task</strong>
        <Action variant="quiet" onClick={() => void dismiss()}>
          Got it
        </Action>
      </div>
      <div className="v2-first-task-grid">
        {[
          ['Task', 'The agent works in its own copy of the code, on a free computer'],
          ['Pull request', 'You review the change; a second model reviews it first'],
          ['Release', 'Merging ships it, and every app in the project moves together'],
        ].map(([title, text], index) => (
          <div key={title}>
            <span className="dl-meta">{index + 1} of 3</span>
            <p>
              <strong>{title}</strong>
            </p>
            <p className="dl-meta">{text}</p>
          </div>
        ))}
      </div>
    </aside>
  ) : null;
}
