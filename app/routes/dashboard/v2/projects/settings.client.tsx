'use client';
import { useProjectFormatting } from './formatting.ts';
import { useEffect, useRef, useState } from 'react';
import {
  Action,
  Banner,
  ChipSelect,
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
import type {
  Project,
  ProjectSetting,
  ProjectReleaseSettings,
} from '../../../../../shared/v2/contracts';
import { request, useData, type Overview } from './data';
import { useSearchParams } from 'react-flight-router/client';
import { useCoordinatorName } from '../data/hooks';

import { projectPath, projectSegment } from './routing';
import { NoRepository } from './repository-connect.client';
import { RepositorySettings } from './repository-settings.client';
import { StorageSettings } from './storage-settings.client';

export function ProjectConfiguration({
  project,
  overview,
}: {
  project: Project;
  overview: Overview;
}) {
  const { formatTime } = useProjectFormatting();
  const coordinator = useCoordinatorName();
  const single = project.apps.length === 1;
  const path = `/api/projects/${projectSegment(project.id)}`;
  const appNames = project.apps.map((app) => app.name);
  const removalDescription =
    appNames.length === 0
      ? 'Removes the project. There are no apps to stop or addresses to free.'
      : appNames.length === 1
        ? `Stops ${appNames[0]} and frees its address.`
        : 'Stops the apps and frees their addresses.';
  const removalConsequence =
    appNames.length === 0
      ? 'This project has no apps to stop or addresses to free.'
      : `This would stop ${appNames.length === 2 ? appNames.join(' and ') : appNames.join(', ')} and free ${appNames.length === 1 ? 'its' : 'their'} addresses.`;
  const settings = useData<ProjectReleaseSettings>(`${path}/settings`);
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
  const [confirmation, setConfirmation] = useState('');
  async function policy(update: Partial<ProjectReleaseSettings>) {
    setBusy(true);
    setError('');
    try {
      await request(`${path}/settings`, { method: 'PATCH', body: JSON.stringify(update) });
      settings.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeProject() {
    setBusy(true);
    setError('');
    try {
      await request(path, { method: 'DELETE', body: JSON.stringify({ confirm: confirmation }) });
      window.location.assign('/dashboard/projects');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
  const deepLink = params.get('key') || params.get('editSecret');
  const opened = useRef('');
  useEffect(() => {
    if (!settings.data || !deepLink || opened.current === deepLink) return;
    opened.current = deepLink;
    const row = settings.data.values.find((entry) => entry.key === deepLink);
    edit(row);
    if (!row) {
      setKey(deepLink);
      setType('string');
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
      {error && !editing && !removing && <Banner kind="danger" title={error} />}
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
          {single
            ? 'Your running app keeps its current values.'
            : 'Your running apps keep their current values.'}
        </Banner>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Variables and secrets</h2>
        <p className="dl-section-sub">
          {single
            ? `Secrets are encrypted on ${coordinator}, and agents never see their values.`
            : "Shared by the project's apps; limit one to a single app when only it needs it. Secret values are never returned."}
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
                    {!single && <>· {row.app || 'all apps'}</>}
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
      {overview.repository ? (
        <>
          <RepositorySettings project={project} />
          <StorageSettings project={project} />
        </>
      ) : (
        !project.fromDiscover && !overview.repositoryError && <NoRepository project={project} />
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Releases</h2>
        <p className="dl-section-sub">
          {single
            ? 'A release covers the app and its migrations.'
            : 'One release covers every app in the project, and its migrations.'}
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
          <Setting label="Keep earlier releases" description="For instant rollback">
            <input
              className="v2-release-count"
              type="number"
              aria-label="Keep earlier releases"
              min={1}
              max={100}
              key={settings.data?.keepReleases}
              disabled={busy || !settings.data}
              defaultValue={settings.data?.keepReleases ?? 5}
              onBlur={(event) => {
                const keepReleases = Number(event.target.value);
                if (keepReleases !== settings.data?.keepReleases) void policy({ keepReleases });
              }}
            />
          </Setting>
          <Setting
            label="Verify migrations"
            description="Run them on a copy of the data before switching"
          >
            <Switch
              label="Verify migrations"
              checked={settings.data?.verifyMigrations ?? true}
              disabled={busy || !settings.data}
              onChange={(verifyMigrations) => void policy({ verifyMigrations })}
            />
          </Setting>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Packages</h2>
        <Group>
          <Setting label="Install through deploy.local">
            <Switch
              label="Install through deploy.local"
              checked={settings.data?.installThroughDeploy ?? true}
              disabled={busy || !settings.data}
              onChange={(installThroughDeploy) => void policy({ installThroughDeploy })}
            />
          </Setting>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Remove</h2>
        <Group>
          <Setting
            label={`Remove ${project.name}`}
            description={`${removalDescription} Backups stay for 30 days.`}
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
            <Action variant="quiet" onClick={() => setRemoving(false)}>
              Cancel
            </Action>
            <Action
              variant="danger"
              loading={busy}
              disabled={confirmation !== project.name}
              onClick={() => void removeProject()}
            >
              Remove project
            </Action>
          </>
        }
      >
        <p>{removalConsequence}</p>
        <p>Backups stay for 30 days. A running release must finish first.</p>
        <Field
          label={`Type ${project.name} to confirm`}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {error && <Banner kind="danger" title={error} />}
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
              <ChipSelect
                label="Kind"
                value={type}
                onChange={setType}
                options={[
                  { value: 'secret', label: 'Secret' },
                  { value: 'string', label: 'Variable' },
                  { value: 'number', label: 'Number' },
                  { value: 'boolean', label: 'Boolean' },
                ]}
              />
            </label>
          )}
          {type === 'boolean' ? (
            <label>
              Value
              <ChipSelect
                label="Value"
                value={value}
                onChange={setValue}
                options={[
                  { value: '', label: 'Choose a value' },
                  { value: 'true', label: 'true' },
                  { value: 'false', label: 'false' },
                ]}
              />
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
            <ChipSelect
              label="Available to"
              disabled={existing}
              value={app}
              onChange={setApp}
              options={[
                { value: '', label: 'All apps' },
                ...project.apps.map((app) => ({
                  value: app.name,
                  label: `${app.name} · ${app.kind === 'worker' ? 'Worker' : 'Web app'}`,
                })),
              ]}
            />
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
