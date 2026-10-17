'use client';

import { useState } from 'react';
import tokens from '../../design-tokens.json';
import {
  Select,
  Button,
  TextField,
  Metric,
  LoadingState,
  ErrorBanner,
  EmptyState,
  ConfirmDialog,
  Toggle,
} from '../../components/ui';
import './design-system.css';

const recipes = {
  react: `import { Button, TextField, Select, Metric, StatCard } from '@/components/ui';

<TextField label="Filter computers" appearance="plain"
  type="search" value={filter}
  onChange={(event) => setFilter(event.target.value)} />
<Select aria-label="Branch" value={branch}
  onChange={(event) => setBranch(event.target.value)}>
  <option value="main">main</option>
  <option value="feature">feature</option>
</Select>
<Button variant="primary" onClick={save}>Save changes</Button>
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
// States: text-success, text-warning, text-danger
// Metrics: text-metric-cpu, -memory, -traffic, -latency`,
};
const colorAliases: Record<string, string> = {
  text: 'ink',
  tertiary: 'muted',
  actionHover: 'accent-hover',
};

function CodeSample({ title, code }: { title: string; code: string }) {
  const [state, setState] = useState('Copy');
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState('Copied');
    } catch {
      setState('Select code to copy');
    }
  }
  return (
    <div className="ds-reference-code">
      <div>
        <strong>{title}</strong>
        <Button variant="quiet" onClick={() => void copy()}>
          {state}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={`${title} code`}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function DesignSystemClient() {
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('preview-app');
  const [feedback, setFeedback] = useState('empty');
  const [dialog, setDialog] = useState(false);
  const [option, setOption] = useState(false);
  const [recipe, setRecipe] = useState<'react' | 'tailwind'>('react');
  const signals = Object.entries(tokens.metricSignals);
  return (
    <div className="ds-reference">
      <div className="ds-reference-note">
        Live reference · React components and Tailwind share the application tokens. Specimen values
        are illustrative.
      </div>
      <section id="design-foundations" aria-labelledby="foundations-title">
        <h2 id="foundations-title">Foundations</h2>
        <p>
          Plum surfaces, lavender actions, Manrope text and JetBrains Mono code. Colors follow your
          system appearance.
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
            'success',
            'warning',
            'danger',
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
      <section id="design-components" aria-labelledby="components-title">
        <h2 id="components-title">Components</h2>
        <p>
          These specimens import the shared React components. Inputs preserve native editing and
          labels; plain fields use an accent underline on focus.
        </p>
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
            <Button
              variant="quiet"
              onClick={() => document.getElementById('design-react-and-tailwind')?.scrollIntoView()}
            >
              View code
            </Button>
            <Button variant="danger" disabled>
              Delete unavailable
            </Button>
            <span className="ds-reference-controls">
              <Toggle label="Preview option" enabled={option} onChange={() => setOption(!option)} />{' '}
              Preview option {option ? 'on' : 'off'}
            </span>
          </div>
        </div>
        <div className="ds-reference-example">
          <h3>Fields</h3>
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
              <LoadingState message="Loading specimen…" />
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
      <section id="design-patterns" aria-labelledby="patterns-title">
        <h2 id="patterns-title">Patterns</h2>
        <dl className="ds-reference-rules">
          {(
            [
              'navigation',
              'rightPanes',
              'inputs',
              'selection',
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
