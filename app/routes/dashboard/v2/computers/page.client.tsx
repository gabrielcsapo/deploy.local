'use client';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Dialog,
  Empty,
  Field,
  Glyph,
  Group,
  Head,
  Icon,
  IconButton,
  Item,
  Setting,
  Skeleton,
  Status,
  Switch,
  Tabs,
} from '@/components/ui';
import type {
  Computer,
  ComputerModels,
  ComputerRemoval,
  ComputerUpdateOverview,
  Role,
} from '../../../../../shared/v2/contracts';
import { desktopMacDownload, useMacDownload } from '@/hooks/useDesktopDownload';
import { computerRequest, useComputerData } from './data';
import './style.css';
const base = '/dashboard/computers';
const roleNames: Record<Role, string> = {
  coordinator: 'Coordinator',
  'take-tasks': 'Take tasks',
  'run-apps': 'Run apps',
  'serve-models': 'Serve models',
  'use-screen': 'Use the screen',
};
const computerPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">{title}</h2>
      {description && <p className="dl-meta computers-description">{description}</p>}
      <div className="computers-section-body">{children}</div>
    </section>
  );
}
function ComputerStatus({ computer }: { computer: Computer }) {
  const tasks = computer.doing.filter((d) => d.kind === 'task' || d.kind === 'job').length;
  return (
    <Status kind={!computer.online ? 'inactive' : tasks ? 'active' : 'healthy'}>
      {!computer.online
        ? 'Offline'
        : tasks
          ? `Running ${tasks} task${tasks === 1 ? '' : 's'}`
          : 'Online'}
    </Status>
  );
}
function ComputerList({
  computers,
  updates,
}: {
  computers: Computer[];
  updates?: ComputerUpdateOverview;
}) {
  return (
    <Group>
      {computers.map((computer) => {
        const update = updates?.computers.find((u) => u.id === computer.id);
        return (
          <Item
            key={computer.id}
            lead={
              <Glyph kind="plain">
                <Icon name="computer" size={12} />
              </Glyph>
            }
            title={computer.name}
            description={[computer.roles.map((r) => roleNames[r]).join(' · '), update?.reason]
              .filter(Boolean)
              .join(' · ')}
            href={computerPath(computer.id)}
            end={
              <span className="computers-row-end">
                {update ? (
                  <Status
                    kind={
                      update.state === 'failed'
                        ? 'failed'
                        : update.state === 'updating'
                          ? 'active'
                          : update.state === 'current'
                            ? 'healthy'
                            : update.state === 'waiting'
                              ? 'active'
                              : 'inactive'
                    }
                  >
                    {
                      {
                        failed: 'Update failed',
                        updating: 'Updating',
                        current: 'Up to date',
                        waiting: 'Waiting',
                        ready: 'Ready to update',
                        offline: 'Offline',
                        unavailable: 'Unavailable',
                      }[update.state]
                    }
                  </Status>
                ) : (
                  <ComputerStatus computer={computer} />
                )}
                <span>
                  {update
                    ? computer.version || 'Version unavailable'
                    : computer.doing.find((d) => d.kind === 'task')?.name ||
                      (computer.disk?.used !== undefined && computer.disk.total
                        ? `Disk ${Math.round((computer.disk.used / computer.disk.total) * 100)}%`
                        : '')}
                </span>
              </span>
            }
          />
        );
      })}
    </Group>
  );
}
function AddComputer({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(''),
    [enrollment, setEnrollment] = useState<{ code: string; expiresAt: number; name: string }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const joined = useComputerData<{ computers: Computer[] }>('/computers');
  const macDownload = useMacDownload();
  const connected =
    enrollment &&
    joined.data?.computers.some(
      (computer) => computer.nodeId && computer.name === enrollment.name && computer.online,
    );
  const expired = enrollment && Date.now() >= enrollment.expiresAt;
  const command =
    typeof window === 'undefined' ? '' : `sudo deploy computer join ${window.location.origin}`;
  async function enroll() {
    setBusy(true);
    setError('');
    try {
      setEnrollment(await computerRequest('/computers/enrollment', 'POST', { name }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setError('Select and copy the command below. Clipboard access is unavailable.');
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a computer"
      actions={
        <>
          <Action variant="quiet" onClick={copy} disabled={!enrollment || !!expired}>
            {copied ? 'Copied' : 'Copy command'}
          </Action>
          <Action onClick={onClose}>Done</Action>
        </>
      }
    >
      <div className="computers-dialog-content">
        <p className="dl-soft">
          Install the deploy.local app on the computer you want to add and sign in. It asks which
          roles to take: Take tasks, Run apps, Serve models, Use the screen.
        </p>
        <div className="computers-actions">
          {macDownload ? (
            <a className="dl-btn primary" href={desktopMacDownload} download>
              Download for Mac
            </a>
          ) : (
            <Action variant="primary" disabled>
              Download for Mac
            </Action>
          )}
          <Action disabled>Linux</Action>
          <Action disabled>Windows</Action>
        </div>
        {macDownload !== undefined && (
          <p className="dl-meta">
            {macDownload
              ? 'Apple silicon. Windows and Linux builds aren’t published yet.'
              : 'Desktop installers are not published yet. An existing desktop app can join by signing in.'}
          </p>
        )}
        <Section title="For a server without a screen">
          <Field
            label="Computer name"
            value={name}
            disabled={!!enrollment}
            onChange={(e) => setName(e.target.value)}
            placeholder="bazzite"
          />
          {!enrollment && (
            <Action loading={busy} disabled={!name.trim()} onClick={enroll}>
              Create join code
            </Action>
          )}
          {enrollment && (
            <>
              <pre className="dl-term">{command}</pre>
              <p className="dl-meta">
                Enter <code>{enrollment.code}</code> when asked. Reserved for {enrollment.name};
                expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.
              </p>
              <p className="dl-meta">
                Run this command on Linux with the deploy CLI installed. Roles are shown on the
                computer’s page once it connects.
              </p>
            </>
          )}
        </Section>
        {enrollment && (
          <>
            <Status kind={connected ? 'healthy' : expired ? 'inactive' : 'running'}>
              {connected
                ? `${enrollment.name} is connected`
                : expired
                  ? 'Join code expired'
                  : `Waiting for ${enrollment.name} to connect…`}
            </Status>
            {expired && (
              <Action onClick={() => setEnrollment(undefined)}>Create another code</Action>
            )}
          </>
        )}
        {error && <Banner kind="danger" title={error} />}
      </div>
    </Dialog>
  );
}
function Models() {
  const { data, error, refresh } = useComputerData<ComputerModels>('/computers/models');
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  async function change(key: keyof ComputerModels['defaults'], value: string) {
    if (!data) return;
    setSaving(true);
    setSaveError('');
    try {
      await computerRequest('/computers/models', 'PUT', {
        defaults: { ...data.defaults, [key]: value || null },
      });
      refresh();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (!data)
    return error ? (
      <Banner kind="danger" title={error} action={<Action onClick={refresh}>Retry</Action>} />
    ) : (
      <Skeleton rows={5} />
    );
  return (
    <>
      {(error || saveError) && <Banner kind="danger" title={error || saveError} />}
      <Section
        title="On your computers"
        description="Local models served by computers with Serve models turned on."
      >
        <Group>
          {data.local.length ? (
            data.local.map((model) => (
              <Item
                key={`${model.computer}:${model.id}`}
                lead={
                  <Glyph kind="plain">
                    <Icon name="computer" size={12} />
                  </Glyph>
                }
                title={model.name}
                description={`Local on ${model.computer} · free`}
                end={model.loaded ? 'Loaded' : 'Not loaded'}
              />
            ))
          ) : (
            <Item
              title="No local models reported"
              description="Connect a computer running a model server to see its models here."
            />
          )}
        </Group>
      </Section>
      <Section title="Subscriptions" description="Counted against your plan limits.">
        <Group>
          {data.providers.map((provider) => (
            <Item
              key={provider.id}
              lead={<Glyph>{provider.name[0]}</Glyph>}
              title={provider.name}
              description={
                provider.computers.length
                  ? `On ${provider.computers.join(', ')}`
                  : 'Not signed in on a reporting computer'
              }
              end={
                <span className="computers-row-end">
                  {provider.weekly && (
                    <progress
                      aria-label={`${provider.name} weekly usage`}
                      max={100}
                      value={provider.weekly.usedPercent}
                    />
                  )}
                  <span>
                    {provider.weekly
                      ? `${provider.weekly.usedPercent}% of weekly limit`
                      : 'Weekly usage unavailable'}
                  </span>
                </span>
              }
            />
          ))}
        </Group>
      </Section>
      <Section
        title="Which model does what"
        description="The one place this is set. The model pill changes the current chat only."
      >
        <Group>
          <div className="dl-inset">
            {(
              [
                ['writing-code', 'Writing code'],
                ['reviewing', 'Reviewing'],
                ['answering-questions', 'Answering questions'],
              ] as const
            ).map(([key, label]) => (
              <Setting key={key} label={label}>
                <select
                  className="computers-select"
                  aria-label={label}
                  disabled={saving}
                  value={data.defaults[key] || ''}
                  onChange={(e) => void change(key, e.target.value)}
                >
                  <option value="">Choose a model</option>
                  {data.defaults[key] && !data.choices.some((c) => c.id === data.defaults[key]) && (
                    <option value={data.defaults[key]!}>Unavailable · {data.defaults[key]}</option>
                  )}
                  {data.choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name} · {choice.provider}
                    </option>
                  ))}
                </select>
              </Setting>
            ))}
          </div>
        </Group>
      </Section>
    </>
  );
}
function RemoveComputer({ computer, close }: { computer: Computer; close: () => void }) {
  const { data, error, refresh } = useComputerData<ComputerRemoval>(
    `/computers/${encodeURIComponent(computer.id)}/removal`,
  );
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  async function remove() {
    setBusy(true);
    setFailure('');
    try {
      await computerRequest(`/computers/${encodeURIComponent(computer.id)}`, 'DELETE');
      window.location.assign(base);
    } catch (error) {
      setFailure((error as Error).message);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={close}
      title={`Remove ${computer.name}?`}
      actions={
        <>
          <Action variant="quiet" onClick={close}>
            Cancel
          </Action>
          <Action variant="danger" disabled={!data?.allowed} loading={busy} onClick={remove}>
            Remove computer
          </Action>
        </>
      }
    >
      <div className="computers-dialog-content">
        <p className="dl-soft">
          Apps need a new home first. Active tasks finish before this computer can be removed.
        </p>
        {!data && !error && <Skeleton rows={3} />}
        {data && (
          <>
            <Group>
              {data.apps.map((app) => (
                <Item
                  key={app.id}
                  title={app.name}
                  description={
                    app.destinations.length
                      ? `Move its data first · available computers: ${app.destinations.map((c) => c.name).join(', ')}`
                      : 'No other online computer can run apps'
                  }
                  href={`/dashboard/live/${encodeURIComponent(app.id)}`}
                  end="Review"
                />
              ))}
              {data.tasks.map((task) => (
                <Item
                  key={task.id}
                  title={task.name}
                  description="Wait for this task to finish"
                  end="Running"
                />
              ))}
            </Group>
            {data.reasons.map((reason) => (
              <Banner key={reason} title={reason} />
            ))}
            {data.allowed && (
              <p className="dl-soft">No apps or active tasks depend on this computer.</p>
            )}
          </>
        )}
        <div className="dl-notice">
          Its key stops working right away. Nothing is erased from {computer.name}’s disk; do that
          yourself if you are giving it away.
        </div>
        {(error || failure) && <Banner kind="danger" title={error || failure} />}
      </div>
    </Dialog>
  );
}
function Detail({ computer, refresh }: { computer: Computer; refresh: () => void }) {
  const [removing, setRemoving] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const coordinator = computer.roles.includes('coordinator');
  async function role(role: Role, checked: boolean) {
    setBusy(true);
    setError('');
    try {
      await computerRequest(`/computers/${encodeURIComponent(computer.id)}`, 'PATCH', {
        roles: checked ? [...computer.roles, role] : computer.roles.filter((r) => r !== role),
      });
      refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const gb = (value: number) => Math.round(value / 1024 ** 3);
  return (
    <>
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title computers-title">
            {computer.name} <ComputerStatus computer={computer} />
          </h1>
          <span className="dl-meta">
            {[
              coordinator ? 'Coordinator' : null,
              computer.platform,
              computer.cpuModel,
              computer.memory ? `${gb(computer.memory.total)} GB` : null,
              computer.version ? `deploy.local ${computer.version}` : 'Version unavailable',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        {!coordinator && (
          <Action variant="danger" onClick={() => setRemoving(true)}>
            Remove computer
          </Action>
        )}
      </div>
      {error && <Banner kind="danger" title={error} />}
      <div className="computers-metrics">
        {[
          {
            name: 'CPU',
            value: computer.cpu === undefined ? 'Unavailable' : `${computer.cpu}%`,
            percent: computer.cpu,
          },
          ...(['memory', 'disk'] as const).map((key) => ({
            name: key === 'memory' ? 'Memory' : 'Disk',
            value: computer[key]
              ? computer[key].used === undefined
                ? `${gb(computer[key].total)} GB total`
                : `${gb(computer[key].used!)} of ${gb(computer[key].total)} GB`
              : 'Unavailable',
            percent:
              computer[key]?.used !== undefined && computer[key]!.total
                ? (computer[key]!.used! / computer[key]!.total) * 100
                : undefined,
          })),
        ].map((metric) => (
          <div key={metric.name} className="computers-metric">
            <span className="dl-meta">{metric.name}</span>
            <span className="dl-title">{metric.value}</span>
            {metric.percent !== undefined && (
              <progress max={100} value={metric.percent} aria-label={metric.name} />
            )}
          </div>
        ))}
      </div>
      <div className="dl-cols">
        <Section title="Runs">
          <Group>
            {computer.doing.length ? (
              computer.doing.map((item) => (
                <Item
                  key={`${item.kind}:${item.id}`}
                  title={item.name}
                  description={
                    item.kind === 'app'
                      ? 'App'
                      : item.kind === 'task'
                        ? 'Task'
                        : item.kind === 'model'
                          ? 'Local model'
                          : 'Job'
                  }
                  lead={
                    <Glyph kind="plain">
                      <Icon name={item.kind === 'task' ? 'running' : 'computer'} size={12} />
                    </Glyph>
                  }
                  href={
                    item.kind === 'app'
                      ? `/dashboard/live/${encodeURIComponent(item.id)}`
                      : undefined
                  }
                  end={
                    <Status
                      kind={
                        /failing|failed/i.test(item.state)
                          ? 'failed'
                          : /running|healthy|serving/i.test(item.state)
                            ? 'healthy'
                            : 'inactive'
                      }
                    >
                      {item.state}
                    </Status>
                  }
                />
              ))
            ) : (
              <Item title="Nothing running" />
            )}
          </Group>
        </Section>
        <Section title="Roles">
          <Group>
            <div className="dl-inset">
              {coordinator && (
                <Setting
                  label="Coordinator"
                  description="Runs deploy.local itself · edge on 443 and 80"
                >
                  Always on
                </Setting>
              )}
              {(['take-tasks', 'run-apps', 'serve-models', 'use-screen'] as const).map((r) => (
                <Setting
                  key={r}
                  label={roleNames[r]}
                  description={
                    !computer.supportedRoles.includes(r)
                      ? 'Not available on this computer'
                      : r === 'run-apps' || r === 'serve-models'
                        ? 'Configured on this computer'
                        : undefined
                  }
                >
                  <Switch
                    label={roleNames[r]}
                    checked={computer.roles.includes(r)}
                    disabled={
                      busy ||
                      !computer.supportedRoles.includes(r) ||
                      r === 'run-apps' ||
                      r === 'serve-models'
                    }
                    onChange={(checked) => void role(r, checked)}
                  />
                </Setting>
              ))}
            </div>
          </Group>
        </Section>
      </div>
      {coordinator && (
        <div className="dl-notice">
          <Icon name="send" />
          <span>
            deploy.local runs the coordinator here. Its releases, updates and rollbacks belong to
            the deploy.local project, like any other project.
          </span>
          <a href={`${base}?updates=1`}>Updates</a>
        </div>
      )}
      {removing && <RemoveComputer computer={computer} close={() => setRemoving(false)} />}
    </>
  );
}
function Updates({ computers }: { computers: Computer[] }) {
  const { data, error, refresh } = useComputerData<ComputerUpdateOverview>('/updates');
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  if (!data)
    return error ? (
      <Banner kind="danger" title={error} action={<Action onClick={refresh}>Retry</Action>} />
    ) : (
      <Skeleton rows={3} />
    );
  const releases = data.projectId
    ? `/dashboard/projects/${encodeURIComponent(data.projectId)}/releases`
    : undefined;
  return (
    <>
      {data.latestRelease && (
        <div className="dl-notice">
          <Icon name="send" />
          <span>
            deploy.local {data.latestRelease.apps.find((a) => a.appId === 'deploy.local')?.to} is
            Live.{' '}
            {data.automatic
              ? 'Automatic updates are on for supported computers, when idle.'
              : 'Automatic computer updates are off.'}
          </span>
          {releases && <a href={releases}>Releases</a>}
        </div>
      )}
      {saveError && <Banner kind="danger" title={saveError} />}
      <ComputerList computers={computers} updates={data} />
      <Section title="How deploy.local updates">
        <Group>
          <div className="dl-inset">
            <Setting
              label={computers.find((c) => c.roles.includes('coordinator'))?.name || 'Coordinator'}
              description={
                data.coordinatorReason ||
                'Released like any project: prepare, verify, activate, roll back'
              }
            >
              {releases ? <a href={releases}>deploy.local releases</a> : 'No project release yet'}
            </Setting>
            <Setting
              label="Other computers"
              description={
                data.automaticReason || 'Update within 10 minutes of a release, when idle'
              }
            >
              <Switch
                label="Auto-update computers"
                checked={data.automatic}
                disabled={saving}
                onChange={async (automatic) => {
                  setSaving(true);
                  setSaveError('');
                  try {
                    await computerRequest('/updates', 'PUT', { automatic });
                    refresh();
                  } catch (error) {
                    setSaveError(
                      error instanceof Error ? error.message : 'Unable to save automatic updates.',
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              />
            </Setting>
            <Setting
              label="Desktop and iPhone apps"
              description="Installed app updates are managed on each device"
            >
              On the device
            </Setting>
          </div>
        </Group>
      </Section>
    </>
  );
}
export default function Computers() {
  const { pathname } = useLocation();
  const key = decodeURIComponent(pathname.split('/')[3] || '');
  const { data, error, refresh } = useComputerData<{ computers: Computer[] }>('/computers');
  const [adding, setAdding] = useState(false);
  const updates =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('updates');
  const computer = data?.computers.find((c) => c.id === key);
  const detail = !!key && !['models', 'add'].includes(key);
  const selected = key === 'models' ? `${base}/models` : key === 'add' ? `${base}/add` : base;
  return (
    <>
      <Head
        title={key === 'models' ? 'Models' : detail ? computer?.name || 'Computer' : 'Computers'}
        subtitle={detail ? 'Computer' : undefined}
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <div className="dl-scroll">
        <div className="dl-page computers-page">
          {!detail && (
            <Tabs
              value={selected}
              items={[
                { label: 'Computers', href: base, count: data?.computers.length },
                { label: 'Models', href: `${base}/models` },
                { label: 'Add a computer', href: `${base}/add` },
              ]}
            />
          )}
          {error && (
            <Banner kind="danger" title={error} action={<Action onClick={refresh}>Retry</Action>} />
          )}
          {key === 'models' ? (
            <Models />
          ) : !data ? (
            <Skeleton rows={3} />
          ) : detail ? (
            computer ? (
              <Detail computer={computer} refresh={refresh} />
            ) : (
              <Empty
                title="Computer not found"

                actions={
                  <a className="dl-btn" href={base}>
                    Computers
                  </a>
                }
              />
            )
          ) : (
            <>
              <div className="dl-page-head">
                <div className="dl-t">
                  <h1 className="dl-title">Computers</h1>
                  <span className="dl-meta">
                    {data.computers.filter((c) => c.online).length} online ·{' '}
                    {
                      data.computers.filter((c) =>
                        c.doing.some((d) => d.kind === 'task' || d.kind === 'job'),
                      ).length
                    }{' '}
                    of {data.computers.length} busy
                  </span>
                </div>
                <Action variant="primary" onClick={() => setAdding(true)}>
                  Add a computer
                </Action>
              </div>
              {updates ? (
                <Updates computers={data.computers} />
              ) : (
                <>
                  {data.computers.length ? (
                    <ComputerList computers={data.computers} />
                  ) : (
                    <Empty title="No computers yet" />
                  )}
                  <div className="dl-notice">
                    <Icon name="computer" />
                    <span>
                      A task goes to any free computer that takes tasks and is signed in to the
                      model it needs. Which model does what is set once, on Models.
                    </span>
                    <a href={`${base}/models`}>Models</a>
                  </div>
                  <a className="dl-meta" href={`${base}?updates=1`}>
                    deploy.local updates
                  </a>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {(adding || key === 'add') && (
        <AddComputer
          onClose={() => {
            setAdding(false);
            if (key === 'add') window.location.assign(base);
          }}
        />
      )}
    </>
  );
}
