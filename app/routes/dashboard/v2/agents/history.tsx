'use client';
import { useState } from 'react';
import { Action, Banner, Group, Skeleton } from '@/components/ui';
import { SettingsRow } from '@/components/ui/v2/SettingsList';
import type {
  AgentConfiguration,
  AgentTracking,
  LooksAfterItem,
  Project,
} from '../../../../../shared/v2/contracts';
import { itemSummary } from '../../../../../shared/v2/agents';
import { useCoordinatorName, useResource } from '../data/hooks';
import { formatTime } from '../data/time';
import { LooksAfterEditor } from './item';
import { request } from './shared';

export function runDate(at: string, timezone: string, latest?: string) {
  const date = new Date(at);
  const day = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  });
  const age = latest ? (Date.parse(latest) - date.getTime()) / 86400000 : 0;
  if (age > 0 && age <= 7) return `Last ${day}, ${time}`;
  if (age > 7)
    return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: timezone })}, ${time}`;
  return `${day}, ${time}`;
}

export function AgentHistory({
  agent,
  itemId,
  onChanged,
}: {
  agent: AgentConfiguration;
  itemId: string;
  onChanged: (agent: AgentConfiguration) => void;
}) {
  const item = agent.looksAfter?.find((entry) => entry.id === itemId);
  const coordinator = useCoordinatorName();
  const projects = useResource<{ projects: Project[] }>('/api/v2/projects').data?.projects ?? [];
  const path = `/agents/${encodeURIComponent(agent.id)}/items/${encodeURIComponent(itemId)}`;
  const {
    data,
    loading,
    error: loadError,
  } = useResource<{ runs: NonNullable<AgentTracking['runs']> }>(`/api/v2${path}/runs`);
  const [edit, setEdit] = useState<LooksAfterItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    try {
      const result = await request(`${path}/run`, 'POST');
      window.location.assign(`/dashboard/tasks/${encodeURIComponent(result.task.id)}`);
    } catch (failure: any) {
      setError(failure.message);
      setBusy(false);
    }
  }
  if (!item) return <Banner kind="danger" title="Looks after item not found" />;
  const summary = itemSummary(item, projects).replace(
    ' · brings',
    ` on ${coordinator}’s clock · brings`,
  );
  const elapsed =
    data?.runs[0] &&
    formatTime(data.runs[0].at, 'elapsed').replace(' hr', 'h').replace(' min', 'm');
  return (
    <div className="dl-scroll">
      <div className="dl-agent-chat">
        <h1 className="dl-title">History</h1>
        <p className="dl-section-sub">
          {item.what.split('\n')[0]} · {summary}.{elapsed && ` Last run ${elapsed} ago.`}
        </p>
        {(error || loadError) && (
          <Banner kind="danger" title={error || 'History is unavailable. Try again.'} />
        )}
        {loading ? (
          <Skeleton rows={2} />
        ) : (
          data && (
            <Group>
              {data.runs.map((entry) => (
                <SettingsRow
                  key={entry.id}
                  title={runDate(entry.at, item.when.timezone, data.runs[0]?.at)}
                  subtitle={`${['succeeded', 'completed', 'finished'].includes(entry.status.toLowerCase()) ? 'Finished' : entry.status[0].toUpperCase() + entry.status.slice(1)} · ${entry.title}`}
                  href={`/dashboard/tasks/${encodeURIComponent(entry.id)}`}
                />
              ))}
              {!data.runs.length && <SettingsRow title="No runs yet" />}
            </Group>
          )
        )}
        <button type="button" className="dl-link" onClick={() => setEdit(item)}>
          Edit item
        </button>
        <Action disabled={!item.confirmedAt || loading} loading={busy} onClick={() => void run()}>
          Run now
        </Action>
      </div>
      {edit && (
        <LooksAfterEditor
          agent={agent}
          item={edit}
          onSaved={onChanged}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}
