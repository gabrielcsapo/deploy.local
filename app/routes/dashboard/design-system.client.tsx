'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'react-flight-router/client';
import tokens from '@/design-tokens.json';
import {
  Action,
  Approval,
  Banner,
  ChipSelect,
  Composer,
  Dialog,
  Diff,
  Empty,
  Field,
  Glyph,
  Group,
  Head,
  Icon,
  IconButton,
  Item,
  Matrix,
  Nav,
  Seg,
  Setting,
  Sidebar,
  Skeleton,
  Status,
  Steps,
  Switch,
  Tabs,
  Term,
  WorkLog,
  ListTemplate,
  DetailTemplate,
  ConversationTemplate,
  SettingsTemplate,
  type ApprovalMode,
  type ComponentState,
} from '@/components/ui';
import './design-system.css';
import { SettingsList, SettingsRow } from '@/components/ui/v2/SettingsList';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { DesignCompare } from '@/components/ui/v2/DesignCompare';

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
    <section>
      <h2 className="dl-section-title">{title}</h2>
      {description && <p className="dl-meta ds-description">{description}</p>}
      {children}
    </section>
  );
}
const sampleSteps = [
  { text: 'Read server/release/activate.ts', icon: 'file' as const },
  { text: 'Ran node --test server/release', icon: 'terminal' as const, detail: '18 passed' },
];
const colorNames = {
  paper: 'canvas',
  sidebar: 'sidebar',
  surface: 'surface',
  ink: 'text',
  'ink-soft': 'secondary',
  muted: 'tertiary',
  line: 'line',
  'line-strong': 'edge',
  selection: 'selected',
  action: 'action',
  accent: 'accent',
  'accent-soft': 'accentSoft',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  active: 'active',
} as const;

function Foundations({ theme, state }: { theme: 'light' | 'dark'; state: ComponentState }) {
  const [on, setOn] = useState(true);
  const [level, setLevel] = useState('');
  const [keep, setKeep] = useState('5');
  const [off, setOff] = useState(false);
  const [answer, setAnswer] = useState(false);
  const [message, setMessage] = useState('Merge #18 and start the pipeline.');
  const actions = (
    <>
      <Action {...state} variant="primary" onClick={() => setAnswer(true)}>
        Merge and release
      </Action>
      <Action {...state}>Review</Action>
      <Action {...state} variant="quiet">
        Not now
      </Action>
    </>
  );
  return (
    <div className="ds-board ds-foundations" id="foundations">
      <div className="ds-intro">
        <div>
          <span className="dl-meta">deploy.local design system · v2</span>
          <h1>Quiet by default. One decision at a time.</h1>
          <p>
            Four type sizes, neutral greys, one near-black action and deploy.local violet for the
            brand. Every screen on this canvas loads these tokens and components.
          </p>
        </div>
        <a className="dl-btn secondary" href="#components">
          Open the full system
        </a>
      </div>
      <div className="ds-grid ds-type-color">
        <Section title="Type" description="Hanken Grotesk. Nothing in the app is larger than 22.">
          <div className="ds-type-list">
            {[
              ['title · 22', 'What should we build?', 'dl-title'],
              ['reply · 16', 'PR #17 shipped overnight. Two things need you.', 'dl-reply'],
              ['body · 15', 'Merge PR #18', 'dl-body'],
              ['ui · 13', 'Self-release pipeline', 'dl-ui'],
              ['meta · 12', 'Today', 'dl-meta'],
              ['code · 12', 'node --test', 'dl-mono'],
            ].map(([label, text, className]) => (
              <div key={label}>
                <span className="dl-meta">{label}</span>
                <span className={className}>{text}</span>
              </div>
            ))}
          </div>
        </Section>
        <Section
          title="Color"
          description="Light first, with a matching dark theme. Violet never fills a button."
        >
          <div className="ds-swatches">
            {Object.entries(colorNames).map(([label, token]) => (
              <div key={label}>
                <div className="ds-swatch" style={{ background: `var(--ds-${token})` }} />
                <span className="dl-strong">{label}</span>
                <span className="dl-meta dl-mono">{tokens.color[theme][token]}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <div className="ds-grid ds-thirds">
        <Section title="Choice menu">
          <div className="ds-row">
            <ChipSelect
              label="Level"
              value={level}
              onChange={setLevel}
              disabled={state.disabled || state.loading}
              options={[
                { value: '', label: 'Any level' },
                ...['info', 'warn', 'error'].map((value) => ({ value, label: value })),
              ]}
            />
            <ChipSelect
              label="Keep earlier releases"
              variant="secondary"
              value={keep}
              onChange={setKeep}
              disabled={state.disabled || state.loading}
              options={Array.from({ length: 100 }, (_, index) => ({
                value: String(index + 1),
                label: String(index + 1),
              }))}
            />
          </div>
        </Section>
        <Section
          title="Buttons"
          description="Near-black for the next decision, bordered for the alternative, plain text to dismiss."
        >
          <div className="ds-row">{actions}</div>
          <div className="ds-row ds-gap-top">
            <span className="dl-chip">
              <Icon name="folder" size={14} />
              deploy.local
            </span>
            <span className="dl-tag">Ready to merge</span>
            <Switch {...state} label="On" checked={on} onChange={setOn} />
            <Switch {...state} label="Off" checked={off} onChange={setOff} />
          </div>
        </Section>
        <Section
          title="Status"
          description="The ! glyph means you must decide, and only Waiting on you uses it. Everything else is state: a spinner, a check, a dot."
        >
          <div className="ds-stack ds-status">
            <Status {...state} kind="running">
              Running
            </Status>
            <Status {...state} kind="waiting">
              Waiting on you
            </Status>
            <Status {...state} kind="ready">
              Ready
            </Status>
            <div className="ds-row">
              <Status {...state}>Healthy</Status>
              <Status {...state} kind="active">
                Busy
              </Status>
              <Status {...state} kind="inactive">
                Stopped
              </Status>
            </div>
            <div className="ds-grid ds-halves ds-gap-top">
              <div>
                <span className="dl-meta">Live, all healthy</span>
                <Group>
                  <Nav
                    {...state}
                    href="/dashboard/live"
                    lead={<Icon name="pulse" />}
                    end="7 running"
                  >
                    Live
                  </Nav>
                </Group>
              </div>
              <div>
                <span className="dl-meta">Live, something failing</span>
                <Group>
                  <Nav
                    {...state}
                    href="/dashboard/live"
                    lead={<Icon name="pulse" />}
                    end={<Status kind="failed">1 failing</Status>}
                  >
                    Live
                  </Nav>
                </Group>
              </div>
            </div>
          </div>
        </Section>
        <Section
          title="Shape"
          description="Radius 8 for controls, 12 for cards, 16 for dialogs, 18 for the composer."
        >
          <div className="ds-row ds-shapes">
            {['control', 'card', 'dialog', 'composer'].map((shape) => (
              <div key={shape}>
                <div style={{ borderRadius: `var(--ds-radius-${shape})` }} />
                <span className="dl-meta">
                  {tokens.radius[shape as keyof typeof tokens.radius]}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <div className="ds-grid ds-halves ds-work">
        <Section
          title="Agent work"
          description="Steps fold into one line. Decisions are cards with one dark button."
        >
          <div className="ds-stack">
            <WorkLog {...state} summary="Worked for 3m" steps={sampleSteps} defaultOpen />
            <Approval
              {...state}
              title="Merge PR #18"
              icon="merge"
              text="Reviewed by GPT-6.1-Sol, 4 checks passed on this version."
              actions={actions}
              answer={
                answer
                  ? {
                      by: 'Gabriel',
                      on: 'web',
                      at: 'Just now',
                      note: 'Merged and released (example)',
                    }
                  : undefined
              }
            />
          </div>
        </Section>
        <Section
          title="Composer"
          description={
            'The same prompt everywhere: “Ask, build, or follow up…”. Context sits beside attach; the model sits beside send.'
          }
        >
          <div className="ds-stack">
            <Composer
              {...state}
              onSend={setMessage}
              onAttach={() => setMessage('Attach menu example')}
              onModel={() => setMessage('The model changes this chat only.')}
              onVoice={() => setMessage('Voice example')}
            />
            <div className="dl-you">{message}</div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function States({ state }: { state: ComponentState }) {
  const [retry, setRetry] = useState(false);
  return (
    <div className="ds-board ds-states" id="states">
      <div className="ds-intro">
        <div>
          <span className="dl-meta">Design system · states</span>
          <h1>Say what happened, and the one thing to do.</h1>
          <p>
            Empty states say what a place is for and offer one action. Loading keeps the layout.
            Errors say what happened, what deploy.local is already doing about it, and one thing you
            can do. Raw errors belong in Logs.
          </p>
        </div>
      </div>
      <div className="ds-grid ds-thirds">
        <Section title="Empty" description="A new install: no projects yet.">
          <Group {...state}>
            <Empty
              title="No projects yet"
              icon="folder"
              actions={
                <>
                  <Action {...state} variant="primary">
                    New project
                  </Action>
                  <Action {...state}>Discover apps</Action>
                </>
              }
            >
              A project is a repository and the apps it runs. Start from code you have, or install
              an app.
            </Empty>
          </Group>
          <Group className="ds-gap-top">
            <Empty {...state} title="Nothing needs you" className="ds-empty-small">
              Agents ask here when they need a decision.
            </Empty>
          </Group>
        </Section>
        <Section
          title="Loading"
          description="Skeleton rows in the real layout. After 10 s, say what is slow."
        >
          <Skeleton {...state} label="Loading projects" slowLabel="" />
          <div className="ds-gap-top">
            <Skeleton {...state} block label="Loading the design" />
          </div>
          <div className="dl-notice ds-gap-top">
            <Icon name="running" className="dl-run" size={14} />
            Connecting to SER… taking longer than usual
          </div>
          <div className="ds-gap-top">
            <WorkLog {...state} live summary="Reading the release diff" />
          </div>
        </Section>
        <Section
          title="Error"
          description="Warning while deploy.local retries or works around it; danger when something failed."
        >
          <div className="ds-stack">
            <Banner
              {...state}
              title={retry ? 'Connecting to SER…' : "Can't reach SER"}
              action={
                <Action {...state} variant="quiet" onClick={() => setRetry(!retry)}>
                  Try now
                </Action>
              }
            >
              Retrying in 8 s. Your drafts are kept.
            </Banner>
            <Banner
              {...state}
              icon="clock"
              title="Claude's weekly limit is used up"
              action={
                <Action {...state} variant="quiet">
                  Change
                </Action>
              }
            >
              Resets Thursday 9 AM. Coding tasks use Codex until then.
            </Banner>
            <Banner
              {...state}
              kind="danger"
              title="Couldn't load logs for home-gym"
              action={
                <Action {...state} variant="quiet">
                  Try again
                </Action>
              }
            >
              SER answered 502. Logs for other apps still load.
            </Banner>
            <Field
              {...state}
              label="Domain"
              defaultValue="photos.deploy.local"
              error="photos.deploy.local is already used by Immich. Try photos2.deploy.local."
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Components({ state }: { state: ComponentState }) {
  const [dialog, setDialog] = useState(false);
  const [segment, setSegment] = useState('waiting');
  const [rules, setRules] = useState<Record<string, Record<string, ApprovalMode>>>({});
  const [notifications, setNotifications] = useState(true);
  return (
    <div className="ds-board ds-components" id="components">
      <h2 className="dl-title">Every component</h2>
      <p className="dl-meta">
        Interactive examples use sample data. Use the state controls to inspect every family.
      </p>
      <div className="ds-grid ds-halves">
        <Section title="Lists and agent identity">
          <SettingsList title="Agents" note="One summary row opens the details.">
            <SettingsRow
              title="Release notes writer"
              subtitle="Say hello"
              lead={<AgentAvatar id="notes" />}
              href="/dashboard/agents/new"
            />
            <SettingsRow
              title="Start a task"
              subtitle="Work on a branch inside its limits"
              value="Ask"
            />
          </SettingsList>
        </Section>
        <Section title="Sidebar and Nav">
          <div className="ds-sidebar-example">
            <Sidebar
              {...state}
              brand={
                <span className="dl-brand">
                  <span className="dl-mark">d</span>deploy.local
                </span>
              }
              navigation={
                <>
                  <Nav {...state} href="/dashboard" active lead={<Icon name="compose" />}>
                    New task
                  </Nav>
                  <Nav
                    {...state}
                    href="/dashboard/live"
                    lead={<Icon name="pulse" />}
                    end="7 running"
                  >
                    Live
                  </Nav>
                </>
              }
              footer={<div className="dl-side-foot">Gabriel · Settings</div>}
            >
              <div className="dl-side-label">Agents</div>
              <Nav {...state} href="/dashboard/agents/scout" lead={<Glyph>S</Glyph>}>
                Scout
              </Nav>
              <Nav
                {...state}
                href="/dashboard/inbox"
                lead={<Icon name="attention" className="dl-attn" />}
              >
                Waiting on you
              </Nav>
            </Sidebar>
          </div>
        </Section>
        <Section title="Head, Group, Item and Setting">
          <Head
            {...state}
            title="Computers"
            subtitle="3 online"
            ruled
            actions={<Action {...state}>Add a computer</Action>}
          />
          <Group {...state} title="Computers">
            <Item
              {...state}
              title="SER"
              description="Coordinator · Run apps"
              lead={<Icon name="computer" />}
              end={<Status>Online</Status>}
              href="/dashboard/computers/ser"
            />
            <Item
              {...state}
              title="bazzite"
              description="Take tasks · Serve models"
              lead={<Icon name="computer" />}
              end={<Status kind="active">Busy</Status>}
              href="/dashboard/computers/bazzite"
            />
          </Group>
          <Setting {...state} label="Notifications" description="When something is Waiting on you">
            <Switch
              {...state}
              label="Notifications"
              checked={notifications}
              onChange={setNotifications}
            />
          </Setting>
        </Section>
        <Section title="Tabs and Seg">
          <Tabs
            {...state}
            label="Task sections"
            value="/dashboard/tasks/self-release"
            items={[
              { label: 'Chat', href: '/dashboard/tasks/self-release' },
              { label: 'Changes', href: '/dashboard/tasks/self-release/changes', count: 3 },
              { label: 'Checks', href: '/dashboard/tasks/self-release/checks', count: 4 },
            ]}
          />
          <div className="ds-gap-top">
            <Seg
              {...state}
              label="Inbox state"
              value={segment}
              onChange={setSegment}
              options={[
                { label: 'Waiting on you', value: 'waiting' },
                { label: 'Answered', value: 'answered' },
              ]}
            />
          </div>
        </Section>
        <Section title="Review choices">
          <span className="dl-rv-choice">
            <Action
              {...state}
              variant="secondary"
              aria-pressed={segment === 'waiting'}
              onClick={() => setSegment('waiting')}
            >
              Keep main’s
            </Action>
            <Action
              {...state}
              variant="primary"
              aria-pressed={segment === 'answered'}
              onClick={() => setSegment('answered')}
            >
              Keep this proposal’s
            </Action>
          </span>
        </Section>
        <Section title="Design comparison">
          <DesignCompare
            before={
              <div className="dl-banner" style={{ width: 280, height: 180 }}>
                Before · main
              </div>
            }
            after={
              <div className="dl-banner" style={{ width: 280, height: 180 }}>
                After · this branch
              </div>
            }
          />
        </Section>
        <Section title="Approval · answered">
          <Approval
            {...state}
            title="Roll back home-gym?"
            text="The previous release is running."
            answer={{ by: 'Gabriel', on: 'iPhone', at: '2:14 PM', note: 'Approved' }}
          />
        </Section>
        <Section title="Dialog">
          <Action onClick={() => setDialog(true)}>Open dialog</Action>
          <Dialog
            {...state}
            open={dialog}
            onClose={() => setDialog(false)}
            title="Ship home-gym?"
            actions={
              <>
                <Action onClick={() => setDialog(false)}>Cancel</Action>
                <Action variant="primary" onClick={() => setDialog(false)}>
                  Close example
                </Action>
              </>
            }
          >
            <p>This is a design-system example. No release will start.</p>
            <Setting label="Computer">SER</Setting>
            <Setting label="Address">home-gym.deploy.local</Setting>
          </Dialog>
        </Section>
        <Section title="Steps and Work log">
          <Steps {...state} steps={sampleSteps} />
          <div className="ds-gap-top">
            <Steps
              {...state}
              numbered
              steps={[
                { text: 'Open deploy.local Desktop and find your coordinator.' },
                { text: 'Check the certificate, then sign in.' },
                { text: 'Choose what it helps with, then Add.' },
              ]}
            />
          </div>
          <div className="ds-gap-top">
            <WorkLog {...state} live summary="Running checks" steps={sampleSteps} />
          </div>
        </Section>
      </div>
      <Section
        title="Matrix"
        description="Actions are Ask me by default. Below 900 px, one group per agent."
      >
        <Matrix
          {...state}
          agents={[
            { id: 'scout', name: 'Scout' },
            { id: 'warden', name: 'Warden' },
            { id: 'keeper', name: 'Keeper' },
          ]}
          actions={[
            { id: 'merge', name: 'Merge' },
            { id: 'ship', name: 'Ship' },
            { id: 'rollback', name: 'Roll back' },
            { id: 'restart', name: 'Restart' },
            { id: 'install', name: 'Install' },
            { id: 'change-secrets', name: 'Change secrets' },
            { id: 'use-screen', name: 'Use the screen' },
            { id: 'spend', name: 'Spend' },
          ]}
          values={rules}
          onChange={(agent, action, mode) =>
            setRules({ ...rules, [agent]: { ...rules[agent], [action]: mode } })
          }
        />
      </Section>
      <Section
        title="Timing waterfall"
        description="Server phases share one scale; the thin marker is the route p95."
      >
        <div className="dl-waterfall" data-waterfall="compact">
          <div className="dl-waterfall-legend dl-meta" aria-label="Timing colors">
            <span>
              <i data-phase="match" aria-hidden="true" />
              Route match
            </span>
            <span>
              <i data-phase="data" aria-hidden="true" />
              Data loading
            </span>
            <span>
              <i data-phase="render" aria-hidden="true" />
              Page render
            </span>
            <span>
              <i data-phase="stream" aria-hidden="true" />
              Streaming
            </span>
          </div>
          <div data-axis-labels>
            <span className="dl-meta">0 ms</span>
            <span className="dl-meta">100 ms</span>
          </div>
          <div data-timing-row>
            <span>/watch/:id</span>
            <span
              className="dl-bar"
              role="img"
              aria-label="Route match 0.1 ms, Data loading 18 ms, Page render 9 ms, Streaming 7 ms; p95 88 ms"
            >
              <span data-phase="match" style={{ left: '0%', width: '0.1%' }} />
              <span data-phase="data" style={{ left: '0.1%', width: '18%' }} />
              <span data-phase="render" style={{ left: '18.1%', width: '9%' }} />
              <span data-phase="stream" style={{ left: '27.1%', width: '7%' }} />
              <i style={{ left: '88%' }} />
            </span>
          </div>
        </div>
      </Section>
      <div className="ds-grid ds-halves">
        <Section title="Term">
          <Term {...state} aria-label="Example release output">
            {
              '$ deploy releases home-gym\n9c3e1fa  Live  SER\nPrepare  done\nVerify   done\nActivate done\nWatch    done'
            }
          </Term>
        </Section>
        <Section title="Diff">
          <Diff
            {...state}
            file="deploy.yaml"
            lines={[
              { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
              { old: 1, new: 1, text: 'name: home-gym' },
              { kind: 'del', old: 2, text: 'releases: 3' },
              { kind: 'add', new: 2, text: 'releases: 5' },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}

// Page templates, with the copy of the approved boards. `?board=TemplateList&capture` shows one as a
// whole page, beside the sidebar, for comparing with the board at 1440 and 700.
const TEMPLATE_BOARDS = [
  'TemplateList',
  'TemplateDetail',
  'TemplateConversation',
  'TemplateSettings',
] as const;
type TemplateBoard = (typeof TEMPLATE_BOARDS)[number];

function TemplateSpecimen({ board }: { board: TemplateBoard }) {
  if (board === 'TemplateList')
    return (
      <ListTemplate
        title="Projects"
        description="Active projects grow. Maintained projects get fixes and updates. Done projects rest."
        actions={
          <>
            <a className="dl-btn secondary" href="#discover">
              Discover apps
            </a>
            <a className="dl-btn primary" href="#new">
              New project
            </a>
          </>
        }
      >
        <section className="dl-section">
          <h2 className="dl-section-title">Active</h2>
          <Group>
            <Item
              title="home-gym · Active"
              description="1 proposal · 1 PR open · last change 3 days ago"
              end={<Status kind="failed">1 failing</Status>}
              href="#home-gym"
            />
            <Item
              title="tally · Active"
              description="2 proposals · 1 PR open · last change 3 days ago"
              end={<Status kind="inactive">Not running</Status>}
              href="#tally"
            />
            <Item
              title="deploy.local · Active"
              description="No proposals · 2 PRs open · last change 6 hours ago"
              end={<Status>Healthy</Status>}
              href="#deploy-local"
            />
          </Group>
        </section>
      </ListTemplate>
    );
  if (board === 'TemplateDetail')
    return (
      <DetailTemplate
        title="home-gym"
        parent={{ label: 'Projects', href: '#projects' }}
        actions={
          <a className="dl-btn primary" href="#new-task">
            New task
          </a>
        }
        tabs={{
          value: '#overview',
          items: [
            { label: 'Overview', href: '#overview' },
            { label: 'Code', href: '#code' },
            { label: 'Pull requests', href: '#pulls' },
            { label: 'Apps', href: '#apps' },
          ],
        }}
      >
        <section className="dl-section">
          <h2 className="dl-section-title">Running</h2>
          <p className="dl-section-sub">
            Release 9c3e1fa on main. Open an app for its health, releases, logs and settings.
          </p>
          <Group>
            <Item title="web" description="Web · SER" end={<Status>Healthy</Status>} href="#web" />
            <Item
              title="sync-worker"
              description="38% of jobs error since 1:58 PM"
              end={<Status kind="failed">Failing</Status>}
              href="#sync-worker"
            />
          </Group>
        </section>
      </DetailTemplate>
    );
  if (board === 'TemplateConversation')
    return (
      <ConversationTemplate
        title="Format the last-updated time as HH:MM:SS"
        actions={
          <>
            <IconButton icon="more" label="More" />
            <Action variant="primary">Merge and release</Action>
          </>
        }
        tabs={{
          value: '#chat',
          items: [
            { label: 'Chat', href: '#chat' },
            { label: 'Changes', href: '#changes', count: 3 },
            { label: 'Checks', href: '#checks', count: 3 },
          ],
        }}
        composer={
          <form className="dl-composer" onSubmit={(event) => event.preventDefault()}>
            <input type="text" placeholder="Ask, build, or follow up…" aria-label="Message" />
            <div className="dl-composer-bar">
              <span className="dl-chip">SER</span>
              <span className="dl-grow" />
              <button type="submit" className="dl-send" aria-label="Send">
                <Icon name="send" />
              </button>
            </div>
          </form>
        }
      >
        <div className="dl-you">
          In Tally, format the last-updated time under the count as HH:MM:SS in 24-hour time
        </div>
        <div className="dl-turn">
          <WorkLog summary="Worked for 6m" steps={sampleSteps} />
          <div className="dl-reply">
            <p>
              The time under the count now reads 14:07:32: hours, minutes and seconds, padded, in
              24-hour time. Midnight reads 00:00:00, and a test covers it.
            </p>
          </div>
        </div>
      </ConversationTemplate>
    );
  return (
    <SettingsTemplate
      title="Settings"
      sections={
        <>
          <Nav href="#general" active>
            General
          </Nav>
          <Nav href="#account">Account and SSH keys</Nav>
          <Nav href="#agents">Agents and approvals</Nav>
          <Nav href="#notifications">Notifications</Nav>
        </>
      }
    >
      <section className="dl-section">
        <h2 className="dl-section-title">Appearance</h2>
        <Group>
          <Setting label="Theme" description="Light, Dark or System">
            System
            <Icon name="chevron" className="dl-chev" />
          </Setting>
          <Setting label="Text size" description="In conversations">
            Default
            <Icon name="chevron" className="dl-chev" />
          </Setting>
        </Group>
      </section>
    </SettingsTemplate>
  );
}

function TemplatePage({ board }: { board: TemplateBoard }) {
  return (
    <div className="dl-app ds-template-page">
      <Sidebar
        brand={
          <span className="dl-brand">
            <span className="dl-mark">d</span>deploy.local
          </span>
        }
        navigation={
          <>
            <Nav href="#new" lead={<Icon name="compose" />}>
              New task
            </Nav>
            <Nav
              href="#projects"
              active={board === 'TemplateList' || board === 'TemplateDetail'}
              lead={<Icon name="folder" />}
            >
              Projects
            </Nav>
            <Nav href="#live" lead={<Icon name="pulse" />} end="1 failing">
              Live
            </Nav>
            <Nav href="#computers" lead={<Icon name="computer" />}>
              Computers
            </Nav>
          </>
        }
        footer={<div className="dl-side-foot">Gabriel · Settings</div>}
      />
      <main className="dl-main">
        <TemplateSpecimen board={board} />
      </main>
    </div>
  );
}

function Templates() {
  return (
    <div className="ds-board" id="templates">
      <h2 className="dl-title">Page templates</h2>
      <p className="dl-meta">
        A new page picks one: list, detail, conversation or settings. Each opens on its own beside
        the sidebar.
      </p>
      <div className="ds-grid ds-halves">
        {TEMPLATE_BOARDS.map((board) => (
          <Section key={board} title={board.replace('Template', '')}>
            <div className="ds-template-frame">
              <main className="dl-main">
                <TemplateSpecimen board={board} />
              </main>
            </div>
            <a className="dl-link" href={`?board=${board}`}>
              Open as a page
            </a>
          </Section>
        ))}
      </div>
    </div>
  );
}

export default function DesignSystemClient() {
  const { url } = useRouter();
  const params = new URL(url, 'http://localhost').searchParams;
  const [theme, setTheme] = useState<'light' | 'dark'>(
    params.get('theme') === 'dark' ? 'dark' : 'light',
  );
  const [preview, setPreview] = useState('default');
  const state = { disabled: preview === 'disabled', loading: preview === 'loading' };
  const board = params.get('board');
  if (board && (TEMPLATE_BOARDS as readonly string[]).includes(board))
    return <TemplatePage board={board as TemplateBoard} />;
  return (
    <div className="dl-sheet ds-reference" data-ds-theme={theme} data-preview-state={preview}>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      {!params.has('capture') && (
        <div className="ds-reference-toolbar">
          <a href="/dashboard">Home</a>
          <Seg
            label="Theme"
            value={theme}
            onChange={(value) => setTheme(value as 'light' | 'dark')}
            options={[
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
          <Seg
            label="Component state"
            value={preview}
            onChange={setPreview}
            options={['default', 'hover', 'focus', 'disabled', 'loading'].map((value) => ({
              value,
              label:
                value === 'focus'
                  ? 'Focus-visible'
                  : value.charAt(0).toUpperCase() + value.slice(1),
            }))}
          />
          <a href="#foundations">Foundations</a>
          <a href="#states">States</a>
          <a href="#components">Components</a>
          <a href="#templates">Templates</a>
        </div>
      )}
      {(!board || board === 'DesignSystem') && <Foundations theme={theme} state={state} />}
      {(!board || board === 'States') && <States state={state} />}
      {(!board || board === 'Components') && <Components state={state} />}
      {(!board || board === 'Templates') && <Templates />}
    </div>
  );
}
