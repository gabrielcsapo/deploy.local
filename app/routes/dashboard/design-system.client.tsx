'use client';
import { Skeleton } from '@/components/ui';
import {
  IconButton,
  CopyButton,
  ActionCluster,
  OverflowMenu,
  WorkspaceIcon,
  type WorkspaceIconName,
} from '@/components/ui';

import { useEffect, useState } from 'react';
import tokens from '../../design-tokens.json';
import workspaceIcons from '../../workspace-icons.json';
import {
  ListPageHeader,
  ListRow,
  ListGroup,
  PropertyRow,
  CompactTopBar,
  NoticeRow,
  ResourceRow,
  ContextChip,
  CollapsibleMessage,
  Select,
  StatusBadge,
  Button,
  TextField,
  SearchField,
  TextArea,
  SegmentedControl,
  Metric,
  LoadingState,
  ErrorBanner,
  EmptyState,
  ConfirmDialog,
  Toggle,
} from '../../components/ui';
import './design-system.css';
import { WorkspaceChromeSpecimen } from './workspace-chrome-specimen.client';

const recipes = {
  react: `import { Button, TextField, SearchField, Select, Metric, StatCard, StatusBadge } from '@/components/ui';

<SearchField label="Filter computers" value={filter}
  onChange={(event) => setFilter(event.target.value)} />
<Select aria-label="Branch" value={branch}
  onChange={(event) => setBranch(event.target.value)}>
  <option value="main">main</option>
  <option value="feature">feature</option>
</Select>
<Button variant="primary" onClick={save}>Save changes</Button>
<StatusBadge tone="healthy" label="Running" />
<Metric signal="cpu" label="CPU">{cpu ?? 'Unavailable'}</Metric>
<StatCard signal="latency" label="Latency · p95"
  value={latency ?? 'Unavailable'} />`,
  tailwind: `<section className="bg-bg text-text divide-y divide-border">
  <div className="flex flex-wrap items-center gap-3 px-4 py-2">
    <span className="text-text-secondary">CPU</span>
    <span className="font-mono text-metric-cpu">{cpu}</span>
  </div>
</section>

// Actions: bg-action text-on-action
// Surfaces: bg-bg, bg-bg-surface, bg-bg-elevated
// States: text-status-active, -attention, -healthy, -failed, -inactive
// Metrics: text-metric-cpu, -memory, -traffic, -latency`,
};
const colorAliases: Record<string, string> = {
  text: 'ink',
  tertiary: 'muted',
  accentHover: 'accent-hover',
};

function CodeSample({ title, code }: { title: string; code: string }) {
  return (
    <div className="ds-reference-code">
      <div>
        <strong>{title}</strong>
        <CopyButton label={`Copy ${title}`} text={code} />
      </div>
      <pre tabIndex={0} aria-label={`${title} code`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function DesignSystemClient() {
  const [cloneProtocol, setCloneProtocol] = useState<'https' | 'ssh'>('https');
  useEffect(() => {
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, []);
  const [wrapped, setWrapped] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('preview-app');
  const [feedback, setFeedback] = useState('empty');
  const [dialog, setDialog] = useState(false);
  const [option, setOption] = useState(false);
  const [motionReplay, setMotionReplay] = useState(0);
  const [reducedPreview, setReducedPreview] = useState(false);
  const [recipe, setRecipe] = useState<'react' | 'tailwind'>('react');
  const signals = Object.entries(tokens.metricSignals);
  return (
    <div className="ds-reference">
      <WorkspaceChromeSpecimen />
      <section aria-label="List page template">
        <h2>List pages</h2>
        <ListPageHeader>
          <Button
            variant="primary"
            onClick={() => document.getElementById('foundations-title')?.scrollIntoView()}
          >
            Explore foundations
          </Button>
          <SearchField
            label="Filter specimen"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </ListPageHeader>
        {'design system'.includes(filter.toLowerCase()) && (
          <ListRow
            to="/dashboard/design-system#design-foundations"
            icon="settings"
            title="Design system"
            secondary="Shared controls and workspace tokens"
            actions={<CopyButton label="Copy reference path" text="/dashboard/design-system" />}
            menu={
              <Button variant="link" data-dismiss-menu onClick={() => setFilter('')}>
                Clear filter
              </Button>
            }
          />
        )}
        <ListGroup title="Row anatomy">
          <PropertyRow label="Main list">Resource row token · at least 52 px</PropertyRow>
          <PropertyRow label="Mac sidebar">32 pt navigation rows</PropertyRow>
          <PropertyRow label="Actions">Hover or focus · always visible on touch</PropertyRow>
        </ListGroup>
      </section>
      <div className="ds-reference-note">
        Live reference · React components and Tailwind share the application tokens. Specimen values
        are illustrative.
      </div>
      <section id="design-foundations" aria-labelledby="foundations-title">
        <h2 id="foundations-title">Foundations</h2>
        <p>
          Quiet surfaces, solid violet actions, system text (SF Pro on Apple devices) and SF Mono
          code. Colors follow your system appearance.
        </p>
        <div className="ds-reference-swatches">
          {[
            'canvas',
            'sidebar',
            'surface',
            'raised',
            'line',
            'text',
            'secondary',
            'accent',
            'action',
            'selected',
            'hover',
            'edge',
            'statusActive',
            'statusAttention',
            'statusHealthy',
            'statusFailed',
            'statusInactive',
          ].map((key) => (
            <div key={key} className="ds-reference-swatch">
              <span style={{ background: `var(--ds-${colorAliases[key] || key})` }} />
              <strong>{key}</strong>
              <code>
                {tokens.color.light[key as keyof typeof tokens.color.light]} /{' '}
                {tokens.color.dark[key as keyof typeof tokens.color.dark]}
              </code>
            </div>
          ))}
        </div>
        <h3>Metric signals</h3>
        <p>
          Keep the same mapping in tables, charts and logs. Pair color with a label, unit and series
          pattern; health has its own status.
        </p>
        <div className="ds-reference-table-wrap" tabIndex={0} aria-label="Metric color mappings">
          <table className="ds-reference-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>CSS token</th>
                <th>Use</th>
                <th>Pattern</th>
              </tr>
            </thead>
            <tbody>
              {signals.map(([key, signal]) => (
                <tr key={key}>
                  <th>
                    <span
                      className="ds-reference-dot"
                      style={{ background: `var(--metric-${key})` }}
                    />
                    {signal.name}
                  </th>
                  <td>
                    <code>--metric-{key}</code>
                  </td>
                  <td>{signal.usage}</td>
                  <td>{signal.pattern}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ds-reference-scale">
          <div>
            <h3>Type · px</h3>
            <dl>
              {Object.entries(tokens.type).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3>Spacing · px</h3>
            <dl>
              {Object.entries(tokens.space).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    <code>--ds-space-{key}</code>
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>
      <section id="design-actions" aria-labelledby="actions-title">
        <h2 id="actions-title">Actions and iconography</h2>
        <p>
          Quiet utilities, with named tooltips, visible focus and touch targets. Copy uses the
          actual icon contract below.
        </p>
        <ActionCluster>
          <IconButton
            icon="wrap"
            label="Wrap specimen"
            pressed={wrapped}
            onClick={() => setWrapped(!wrapped)}
          />
          <CopyButton label="Copy icon contract" text={JSON.stringify(workspaceIcons, null, 2)} />
          <IconButton icon="refresh" label="Refresh unavailable" disabled />
        </ActionCluster>
        <div className="ds-reference-icons">
          {(['compact', 'default', 'touch'] as const).map((size) => (
            <div key={size}>
              <span>{size}</span>
              <IconButton
                size={size}
                icon="pin"
                label={`Pin ${size} specimen`}
                pressed={pinned}
                onClick={() => setPinned(!pinned)}
              />
            </div>
          ))}
        </div>
        <h3>Toolbar rows</h3>
        <p>
          Bordered controls on one row share one height: 36 px with a fine pointer, 44 px on touch
          or below 640 px. Secondary browsing actions move into More on narrow panes, shortcut hints
          hide on touch, and scrolling section strips fade at the edge with more content.
        </p>
        <div className="ds-reference-toolbar">
          <Select aria-label="Branch specimen" defaultValue="main">
            <option value="main">main</option>
            <option value="feature">feature/sync</option>
          </Select>
          <Button variant="link">
            <WorkspaceIcon name="search" /> Go to file <kbd className="ui-kbd">T</kbd>
          </Button>
          <Button>Clone</Button>
          <Button variant="primary">New task</Button>
          <OverflowMenu label="More specimen actions">
            <button data-dismiss-menu>History</button>
            <button data-dismiss-menu>Go to file</button>
          </OverflowMenu>
        </div>
        <nav className="ds-reference-strip ui-scroll-strip" aria-label="Scrolling strip specimen">
          {['Files', 'Issues', 'Pull requests', 'Pipelines', 'Deployment', 'Settings'].map(
            (label, index) => (
              <a key={label} href="#design-actions" aria-current={index ? undefined : 'page'}>
                {label}
              </a>
            ),
          )}
        </nav>
        <CodeSample
          title="Icon actions"
          code={
            '<ActionCluster>\n  <IconButton icon="wrap" label="Wrap output" pressed={wrap} onClick={toggleWrap} />\n  <CopyButton label="Copy output" text={output} />\n  <IconButton icon="close" label="Close Activity" shortcut="Esc" onClick={close} />\n</ActionCluster>'
          }
        />
      </section>
      <section id="design-icons" aria-labelledby="icons-title">
        <h2 id="icons-title">Iconography</h2>
        <p>
          Shared web and native vectors use a 24-point grid, 1.6-point rounded strokes and inherited
          color. Navigation controls the left sidebar; Review uses a distinct diff document. Label
          the action, and reserve accent color for selection.
        </p>
        <div className="ds-reference-icon-grid">
          {(Object.keys(workspaceIcons.glyphs) as WorkspaceIconName[]).map((name) => (
            <div key={name}>
              <WorkspaceIcon name={name} className="ds-icon-compact" />
              <WorkspaceIcon name={name} className="ds-icon-default" />
              <code>{name}</code>
            </div>
          ))}
        </div>
        <CodeSample
          title="Shared icon"
          code={`import { IconButton } from '@/components/ui';

<IconButton icon="review" label="Review changes" />
// Geometry: app/workspace-icons.json
// Regenerate SwiftUI: node scripts/build-workspace-icons.mjs
// Native: WorkspaceGlyph(name: .review, size: 18)`}
        />
      </section>
      <section id="design-components" aria-labelledby="components-title">
        <h2 id="components-title">Components</h2>
        <p>
          These specimens import the shared React components. Inputs preserve native editing and
          labels; plain fields use an accent underline on focus.
        </p>
        <div className="ds-reference-example phone-only">
          <h3>Phone components · specimens</h3>
          <CompactTopBar
            title="Compact layout specimen"
            context="One line of context"
            back="/dashboard/design-system"
          />
          <NoticeRow
            notices={[
              {
                id: 'specimen',
                tone: 'attention',
                content: (
                  <>
                    Notice specimen. <a href="/docs">Read documentation</a>
                  </>
                ),
              },
            ]}
          />
          <ResourceRow
            to="/dashboard/settings"
            name="Resource row specimen"
            secondary="Identity and secondary line"
            status={<StatusBadge tone="inactive" label="Specimen" />}
            summary="No live metrics in this specimen"
          />
          <ContextChip
            label="Specimen picker"
            value={name}
            options={[{ value: name, label: name }]}
            onChange={setName}
          />
          <CollapsibleMessage>
            <p>{'This is specimen text for testing the six-line phone disclosure. '.repeat(12)}</p>
          </CollapsibleMessage>
        </div>
        <div className="ds-reference-example">
          <h3>Actions</h3>
          <div className="ds-reference-controls">
            <Button variant="primary" onClick={() => setDialog(true)}>
              Open dialog
            </Button>
            <Button
              onClick={() => {
                setFilter('');
                setName('preview-app');
              }}
            >
              Reset inputs
            </Button>
            <Button disabled>Delete unavailable</Button>
            <Button
              variant="link"
              onClick={() => document.getElementById('design-react-and-tailwind')?.scrollIntoView()}
            >
              View code
            </Button>
            <span className="ds-reference-controls">
              <Toggle
                checkbox
                label="Preview option"
                enabled={option}
                onChange={() => setOption(!option)}
              />{' '}
              Preview option {option ? 'on' : 'off'}
            </span>
          </div>
        </div>
        <div className="ds-reference-example">
          <h3>Status tones</h3>
          <div className="ds-reference-controls">
            <StatusBadge tone="active" label="Working" />
            <StatusBadge tone="attention" label="Ready to review" />
            <StatusBadge tone="attention" label="Configuration needed" />
            <StatusBadge tone="attention" label="Changes ready to deploy" />
            <StatusBadge tone="healthy" label="Running" />
            <StatusBadge tone="failed" label="Failed" />
            <StatusBadge tone="inactive" label="Offline" />
          </div>
        </div>
        <div className="ds-reference-example">
          <h3>Fields</h3>
          <SegmentedControl
            label="Clone protocol specimen"
            value={cloneProtocol}
            options={[
              { value: 'https', label: 'HTTPS' },
              { value: 'ssh', label: 'SSH' },
            ]}
            onChange={setCloneProtocol}
          />
          <TextArea label="Public key specimen" placeholder="ssh-ed25519 AAAA… computer" />
          <div className="ds-reference-fields">
            <TextField
              label="Application name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={name.trim() ? undefined : 'Enter an application name.'}
            />
            <div className="ds-reference-search">
              <TextField
                label="Filter specimen components"
                appearance="plain"
                type="search"
                placeholder="Filter components…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <span>
                {[
                  'Button',
                  'TextField',
                  'Select',
                  'Metric',
                  'StatCard',
                  'LoadingState',
                  'ErrorBanner',
                  'EmptyState',
                  'ConfirmDialog',
                  'Toggle',
                ]
                  .filter((item) => item.toLowerCase().includes(filter.toLowerCase()))
                  .join(', ') || 'No matching components'}
              </span>
            </div>
          </div>
        </div>
        <div className="ds-reference-example">
          <h3>Measurements</h3>
          <div className="ds-reference-controls">
            <Metric signal="cpu" label="CPU">
              24%
            </Metric>
            <Metric signal="memory" label="Memory">
              1.2 GiB
            </Metric>
            <Metric signal="traffic" label="HTTP requests">
              128/min
            </Metric>
            <Metric signal="latency" label="Latency · p95">
              42 ms
            </Metric>
            <Metric signal="neutral" label="Queue depth">
              Unavailable
            </Metric>
          </div>
        </div>
        <div className="ds-reference-example">
          <div className="ds-reference-controls">
            <h3>Feedback</h3>
            <label className="ds-reference-select">
              Preview state{' '}
              <Select value={feedback} onChange={(e) => setFeedback(e.target.value)}>
                <option value="empty">Empty</option>
                <option value="loading">Loading</option>
                <option value="error">Error</option>
              </Select>
            </label>
          </div>
          <div className="ds-reference-feedback" aria-busy={feedback === 'loading'}>
            {feedback === 'loading' ? (
              <>
                <LoadingState message="Loading specimen…" />
                <Skeleton variant="sidebar" label="Sidebar loading specimen" />
                <Skeleton variant="conversation" label="Conversation loading specimen" />
              </>
            ) : feedback === 'error' ? (
              <ErrorBanner
                message="Could not load this specimen."
                action={<Button onClick={() => setFeedback('empty')}>Retry preview</Button>}
              />
            ) : (
              <EmptyState
                title="No matching resources"
                action={
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setFilter('');
                      document
                        .querySelector<HTMLInputElement>('#design-components input[type=search]')
                        ?.focus();
                    }}
                  >
                    Clear filter
                  </Button>
                }
              />
            )}
          </div>
        </div>
        <ConfirmDialog
          open={dialog}
          title="Component preview"
          message="This uses the same confirmation dialog as the application. Try Tab, Shift+Tab and Escape."
          confirmLabel="Close preview"
          onConfirm={() => setDialog(false)}
          onCancel={() => setDialog(false)}
        />
      </section>
      <section
        id="design-motion"
        aria-labelledby="motion-title"
        data-reduced-motion={reducedPreview || undefined}
      >
        <h2 id="motion-title">Motion</h2>
        <p>
          Movement confirms an action and explains where content appears. Controls respond quickly;
          overlays settle gently. Tables, code, streaming responses and sidebar resizing stay
          steady.
        </p>
        <div className="ds-reference-motion-tokens">
          {Object.entries(tokens.motion.duration).map(([role, value]) => (
            <div key={role}>
              <span>{role}</span>
              <strong>{value} ms</strong>
            </div>
          ))}
        </div>
        <div className="ds-reference-example">
          <div className="ds-reference-controls">
            <h3>Surface entry</h3>
            <Button onClick={() => setMotionReplay((value) => value + 1)}>Replay entry</Button>
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
          </div>
          <div className="ds-reference-controls ds-reference-motion-preference">
            <Toggle
              label="Reduced motion preview"
              enabled={reducedPreview}
              onChange={() => setReducedPreview(!reducedPreview)}
            />
            <span>
              Reduced motion preview {reducedPreview ? 'on' : 'off'} · applies to the specimens
              below
            </span>
          </div>
          <div key={motionReplay} className="ds-reference-motion-panel ds-motion-enter">
            <strong>Ready to work</strong>
            <p>
              {tokens.motion.duration.enter} ms entry · {tokens.motion.distance.small} px travel ·
              shared enter easing
            </p>
          </div>
          <details className="ds-motion-disclosure ds-reference-motion-disclosure">
            <summary>Disclosure movement</summary>
            <p>
              New content settles into place. Keyboard focus and expanded state update immediately.
            </p>
          </details>
        </div>
        <p>
          Reduced motion removes travel, scaling and continuous animation. Actions and focus never
          wait for an animation. Dismissed React dialogs close immediately; exit tokens are for
          surfaces that remain mounted during dismissal.
        </p>
        <CodeSample
          title="React motion"
          code={`<Button onClick={() => setOpen(true)}>Open dialog</Button>
{open && <div className="ds-motion-enter">Content</div>}

// Shared Button, Toggle, Select and ConfirmDialog already use motion tokens.
// No transition: all, route animations or animated sidebar resizing.`}
        />
        <CodeSample
          title="Tailwind motion"
          code={`<div className="motion-safe:animate-surface-enter">Content</div>
<button className="transition-colors duration-motion-fast ease-motion-standard">
  Save changes
</button>

/* CSS: --ds-motion-duration-enter, --ds-motion-easing-enter
   --ds-motion-distance-small, --ds-motion-scale-pressed */`}
        />
      </section>
      <section id="design-patterns" aria-labelledby="patterns-title">
        <h2 id="patterns-title">Patterns</h2>
        <dl className="ds-reference-rules">
          {(
            [
              'navigation',
              'rightPanes',
              'inputs',
              'selection',
              'overlays',
              'feedback',
              'keyboard',
              'resourceState',
              'content',
              'brand',
            ] as const
          ).map((key) => (
            <div key={key}>
              <dt>
                {
                  {
                    navigation: 'Workspace',
                    rightPanes: 'Work pane',
                    inputs: 'Input appearance',
                    selection: 'Dropdowns',
                    overlays: 'Dialogs and menus',
                    feedback: 'Recovery',
                    keyboard: 'Keyboard',
                    resourceState: 'Continuity',
                    content: 'Real capabilities',
                    brand: 'Shared identity',
                  }[key]
                }
              </dt>
              <dd>{tokens.compositionRules[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section id="design-react-and-tailwind" aria-labelledby="usage-title">
        <div className="ds-reference-controls">
          <h2 id="usage-title">React and Tailwind</h2>
          <div className="ds-reference-controls" role="group" aria-label="Code language">
            {(['react', 'tailwind'] as const).map((key) => (
              <Button
                key={key}
                aria-pressed={recipe === key}
                variant={recipe === key ? 'primary' : 'quiet'}
                onClick={() => setRecipe(key)}
              >
                {key === 'react' ? 'React' : 'Tailwind'}
              </Button>
            ))}
          </div>
        </div>
        <p>
          Use React primitives for controls and feedback. Use semantic Tailwind utilities for
          composition. Both resolve to the same generated CSS variables.
        </p>
        <CodeSample
          key={recipe}
          title={recipe === 'react' ? 'Shared components' : 'Semantic utilities'}
          code={recipes[recipe]}
        />
        <p>
          Import from <code>@/components/ui</code>. Available: Button, TextField, Select, Metric,
          StatCard, LoadingState, ErrorBanner, EmptyState, ConfirmDialog and Toggle. The application
          and computer filters already use TextField.
        </p>
      </section>
      <section id="design-updating" aria-labelledby="updating-title">
        <h2 id="updating-title">Updating the system</h2>
        <p>
          Make changes in the repository. This page reads the token source and renders the shared
          components directly; it updates with the application build.
        </p>
        <ol className="ds-reference-steps">
          <li>
            Edit <code>app/design-tokens.json</code> for palette, type, spacing, metrics and
            composition rules.
          </li>
          <li>
            Regenerate <code>app/design-tokens.css</code> with the command below. Add semantic
            utility mappings in <code>app/theme.css</code> when needed.
          </li>
          <li>
            Update or add shared React controls in <code>app/components/ui</code>. Extend these
            specimens in <code>app/routes/dashboard/design-system.client.tsx</code>.
          </li>
          <li>
            Use the shared controls in application views. Verify focus, compact layouts, recovery
            and both system appearances. Keep <code>docs/design-system.md</code> current.
          </li>
        </ol>
        <CodeSample
          title="Regenerate and verify"
          code={'node scripts/build-design-tokens.mjs\npnpm typecheck\npnpm build'}
        />
      </section>
    </div>
  );
}
