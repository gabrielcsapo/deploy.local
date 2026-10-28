'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Action,
  Banner,
  Dialog,
  Field,
  Glyph,
  Group,
  Icon,
  Item,
  Setting,
  Switch,
  Skeleton,
} from '@/components/ui';
import type { Project, ProjectSetting, ProjectSettings } from '../../../../../shared/v2/contracts';
import { request, useData, type Overview } from './data';
import { useSearchParams } from 'react-flight-router/client';
import { formatTime } from '../data/time';
import { projectPath, projectSegment } from './routing';

export function ProjectConfiguration({
  project,
  overview,
}: {
  project: Project;
  overview: Overview;
}) {
  const path = `/api/v2/projects/${projectSegment(project.id)}`;
  const settings = useData<ProjectSettings>(`${path}/settings`);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [type, setType] = useState('secret');
  const [app, setApp] = useState('');
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);
  function edit(row?: ProjectSetting) {
    setKey(row?.key || '');
    setValue(row?.type === 'secret' ? '' : String(row?.value ?? ''));
    setType(row?.type || 'secret');
    setApp(row?.app || '');
    setExisting(!!row);
    setError('');
    setEditing(true);
  }
  const [params] = useSearchParams();
  const deepLink = params.get('editSecret');
  const opened = useRef('');
  useEffect(() => {
    const row = settings.data?.values.find(
      (entry) => entry.key === deepLink && entry.type === 'secret',
    );
    if (row && opened.current !== deepLink) {
      opened.current = deepLink || '';
      edit(row);
    }
  }, [settings.data, deepLink]);
  async function save(remove = false) {
    setBusy(true);
    setError('');
    try {
      if (type === 'secret')
        await request(
          `${path}/secrets/${projectSegment(key)}${remove && app ? `?app=${encodeURIComponent(app)}` : ''}`,
          {
            method: remove ? 'DELETE' : 'PUT',
            ...(!remove ? { body: JSON.stringify({ value, app }) } : {}),
          },
        );
      else {
        const parsed =
          type === 'number' || type === 'integer'
            ? Number(value)
            : type === 'boolean'
              ? value === 'true'
              : value;
        await request(`${path}/settings`, {
          method: 'PUT',
          body: JSON.stringify({ values: [{ key, app, value: parsed }] }),
        });
      }
      setValue('');
      setEditing(false);
      setSaved(true);
      settings.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {settings.error && (
        <Banner title={settings.error} action={<Action onClick={settings.refresh}>Retry</Action>} />
      )}
      {saved && (
        <Banner
          title="Applies on the next release"
          action={
            <a className="dl-btn quiet" href={`${projectPath(project.id)}/releases`}>
              Ship…
            </a>
          }
        >
          Your running apps keep their current values.
        </Banner>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Variables and secrets</h2>
        <p className="dl-section-sub">
          Shared by the project's apps; limit one to a single app when only it needs it. Secret
          values are never returned.
        </p>
        {!settings.data && !settings.error ? (
          <Skeleton rows={4} />
        ) : (
          <Group
            title={`${settings.data?.values.filter((row) => row.type !== 'secret').length || 0} variables · ${settings.data?.values.filter((row) => row.type === 'secret').length || 0} secrets`}
            end={
              <Action variant="quiet" onClick={() => edit()}>
                Add
              </Action>
            }
          >
            {settings.data?.values.map((row) => (
              <Item
                key={`${row.app}:${row.key}`}
                lead={
                  <Glyph kind="plain">
                    {row.type === 'secret' ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        aria-hidden="true"
                      >
                        <circle cx="7" cy="16" r="4" />
                        <path d="m10 13 10-10m-4 4 3 3m-6 0 3 3" />
                      </svg>
                    ) : (
                      <Icon name="terminal" size={14} />
                    )}
                  </Glyph>
                }
                title={<code>{row.key}</code>}
                description={
                  <>
                    {row.type === 'secret'
                      ? `•••••••• · secret · set ${formatTime(row.updatedAt)}`
                      : String(row.value)}{' '}
                    · {row.app || 'all apps'}
                  </>
                }
                end={
                  <Action variant="quiet" onClick={() => edit(row)}>
                    {row.type === 'secret' ? 'Replace' : 'Edit'}
                  </Action>
                }
              />
            ))}
          </Group>
        )}
      </section>
      {overview.repository && (
        <section className="dl-section">
          <h2 className="dl-section-title">Repository</h2>
          <Group>
            <Setting label="Source">
              <code>
                {overview.repository.source?.location ||
                  overview.repository.source?.url ||
                  overview.repository.source?.path ||
                  'Hosted repository'}
              </code>
            </Setting>
            <Setting label="Releases from">
              {overview.repository.defaultBranch || 'Unavailable'}
            </Setting>
            <Setting label="Deploy file">deploy.yaml</Setting>
          </Group>
        </section>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Releases</h2>
        <p className="dl-section-sub">
          One release covers every app in the project, and its migrations.
        </p>
        <Group>
          <Setting
            label="Release after a merge"
            description="Who decides is in Agents and approvals"
          >
            <a className="dl-tag" href="/dashboard/settings/approvals">
              Ask me
            </a>
          </Setting>
          <Setting
            label="Keep earlier releases"
            description="Retention preferences are not available yet"
          >
            <input
              className="dl-matrix-select v2-release-count"
              type="number"
              aria-label="Keep earlier releases"
              min={1}
              max={100}
              disabled
              placeholder="—"
            />
          </Setting>
          <Setting
            label="Verify migrations"
            description="Run them on a copy of the data before switching"
          >
            <Switch label="Verify migrations (always on)" checked disabled onChange={() => {}} />
          </Setting>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Remove</h2>
        <Group>
          <Setting
            label={`Remove ${project.name}`}
            description={`Stops ${project.apps.length === 1 ? 'the app' : 'all apps'} and frees their addresses.`}
          >
            <Action variant="danger" onClick={() => setRemoving(true)}>
              Remove project
            </Action>
          </Setting>
        </Group>
      </section>
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${project.name}?`}
        actions={
          <>
            <Action onClick={() => setRemoving(false)}>Cancel</Action>
            <Action variant="danger" disabled>
              Remove project
            </Action>
          </>
        }
      >
        <p>
          This would stop {project.apps.map((app) => app.name).join(', ') || 'this project’s apps'}{' '}
          and free their addresses.
        </p>
        <Banner title="Project removal is not available yet">
          Removal must retain backups for 30 days. This server does not support that operation yet,
          so nothing will be removed.
        </Banner>
      </Dialog>
      <Dialog
        open={editing}
        onClose={() => {
          if (!busy) {
            setEditing(false);
            setValue('');
          }
        }}
        title={`${existing ? 'Replace' : 'Add'} ${type === 'secret' ? 'a secret' : 'a variable'}`}
        actions={
          <>
            <Action
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setValue('');
              }}
            >
              Cancel
            </Action>
            {existing && type === 'secret' && (
              <Action variant="danger" disabled={busy} onClick={() => void save(true)}>
                Delete secret
              </Action>
            )}
            <Action
              variant="primary"
              loading={busy}
              disabled={!key || (type !== 'secret' && value === '')}
              onClick={() => void save()}
            >
              Save, apply on next release
            </Action>
          </>
        }
      >
        <div className="v2-project-form">
          <Field
            label="Name"
            value={key}
            disabled={existing}
            onChange={(event) => setKey(event.target.value)}
          />
          {!existing && (
            <label>
              Kind
              <select
                className="dl-matrix-select"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="secret">Secret</option>
                <option value="string">Variable</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
              </select>
            </label>
          )}
          {type === 'boolean' ? (
            <label>
              Value
              <select
                className="dl-matrix-select"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">Choose a value</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          ) : (
            <Field
              label="Value"
              type={type === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <label>
            Available to
            <select
              className="dl-matrix-select"
              disabled={existing}
              value={app}
              onChange={(event) => setApp(event.target.value)}
            >
              <option value="">All apps</option>
              {project.apps.map((app) => (
                <option key={app.id} value={app.name}>
                  {app.name} · {app.kind === 'worker' ? 'Worker' : 'Web app'}
                </option>
              ))}
            </select>
          </label>
          {type === 'secret' && (
            <Banner title="Encrypted and given to the app when it starts">
              Agents see the name, never the value.
            </Banner>
          )}
          {error && <Banner kind="danger" title={error} />}
        </div>
      </Dialog>
    </>
  );
}
