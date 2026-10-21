'use client';
import { Button, IconButton } from '../../components/ui/index';
import { WorkspaceIcon } from './workspace-icon';
import { useEffect, useId, useRef, useState } from 'react';

type Model = { id: string; name: string };
type Adapter = { id: string; name: string; available: boolean };
const providerName = (id: string) =>
  id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : 'Local / API';
const title = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : 'Default');
export function ComposerControls({
  adapters,
  adapter,
  models,
  catalogs,
  model,
  efforts,
  effort,
  disabled,
  chooseAdapter,
  chooseModel,
  chooseEffort,
  inline = false,
  desktopOnly = false,
}: {
  inline?: boolean;
  desktopOnly?: boolean;
  adapters: Adapter[];
  adapter: string;
  models: Model[];
  catalogs: { id: string; models: Model[] }[];
  model: string;
  efforts: string[];
  effort: string;
  disabled: boolean;
  chooseAdapter: (value: string) => void;
  chooseModel: (value: string) => void;
  chooseEffort: (value: string) => void;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<'effort' | 'models' | 'custom'>('effort');
  const [custom, setCustom] = useState('');
  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);
  useEffect(() => {
    const dismiss = () => popup.current?.hidePopover();
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, []);
  const name =
    models.find((m) => m.id === model)?.name || model || providerName(adapter) + ' default';
  const levels = ['', ...efforts];
  const index = Math.max(0, levels.indexOf(effort));
  const close = () => {
    if (inline) return;
    popup.current?.hidePopover();
    trigger.current?.focus();
  };
  function position() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect || !popup.current) return;
    const width = Math.min(320, window.innerWidth - 24);
    Object.assign(popup.current.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`,
      bottom: `${window.innerHeight - rect.top + 10}px`,
      maxHeight: `${Math.max(120, rect.top - 22)}px`,
    });
  }
  const effortControls = (
    <>
      {inline ? (
        <div className="pw-phone-effort-heading">
          <label htmlFor={`${id}-effort`}>Reasoning effort: {title(effort)}</label>
          <IconButton
            icon="reset"
            label="Reset effort to default"
            onClick={() => chooseEffort('')}
          />
        </div>
      ) : (
        <div className="pw-effort-heading">
          <WorkspaceIcon name="bolt" className="pw-effort-symbol" />
          <div>
            <strong>{title(effort)}</strong>
            <button className="pw-model-drill" onClick={() => setPage('models')}>
              {name}
              <WorkspaceIcon name="chevron" />
            </button>
          </div>
          <IconButton
            icon="reset"
            label="Reset effort to default"
            onClick={() => chooseEffort('')}
          />
        </div>
      )}
      <div className="pw-effort-track">
        <div className="pw-effort-dots" aria-hidden="true">
          {levels.map((level) => (
            <i key={level || 'default'} />
          ))}
        </div>
        <input
          type="range"
          id={`${id}-effort`}
          aria-label="Reasoning effort"
          aria-valuetext={title(effort)}
          min={0}
          max={levels.length - 1}
          step={1}
          value={index}
          style={
            {
              '--effort-progress': `${(index / Math.max(1, levels.length - 1)) * 100}%`,
            } as React.CSSProperties
          }
          onChange={(e) => chooseEffort(levels[Number(e.target.value)])}
        />
      </div>
      <div className="pw-effort-scale">
        <span>Default</span>
        <span>{title(efforts.at(-1) || '')}</span>
      </div>
    </>
  );
  const modelChoices = (
    <div className="pw-model-list">
      {adapters.map((provider) => (
        <div className="pw-provider-group" key={provider.id}>
          <div className="pw-provider-heading">
            {providerName(provider.id)}
            {!provider.available && <small>Unavailable</small>}
          </div>
          {[
            { id: '', name: 'Default' },
            ...(catalogs.find((c) => c.id === provider.id)?.models || []),
          ].map((m) => (
            <button
              key={m.id}
              disabled={!provider.available}
              aria-label={`${providerName(provider.id)}: ${m.name}`}
              aria-pressed={adapter === provider.id && model === m.id}
              onClick={() => {
                chooseAdapter(provider.id);
                chooseModel(m.id);
                close();
              }}
            >
              <span>{m.name}</span>
              <span aria-hidden="true">
                {adapter === provider.id && model === m.id && <WorkspaceIcon name="check" />}
              </span>
            </button>
          ))}
        </div>
      ))}
      <button
        onClick={() => {
          setCustom(model);
          setPage('custom');
        }}
      >
        Custom model for {providerName(adapter)}…
      </button>
    </div>
  );
  const customEditor = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (custom.trim()) {
          chooseModel(custom.trim());
          if (inline) setPage('models');
          close();
        }
      }}
    >
      <div className="pw-popover-heading">
        <IconButton icon="back" label="Back to models" onClick={() => setPage('models')} />
        <span>Custom model</span>
      </div>
      <label className="pw-custom-model">
        Model ID
        <input
          autoFocus
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Model supported by this agent"
        />
      </label>
      {inline ? (
        <Button variant="link" disabled={!custom.trim()} type="submit">
          Use model
        </Button>
      ) : (
        <button className="pw-custom-save" disabled={!custom.trim()} type="submit">
          Use model
        </button>
      )}
    </form>
  );
  if (inline)
    return (
      <fieldset
        className="pw-phone-model-controls"
        disabled={disabled}
        aria-label="Model and effort"
      >
        {efforts.length > 0 && effortControls}
        {page === 'custom' ? customEditor : modelChoices}
      </fieldset>
    );
  return (
    <div className={`pw-composer-options${desktopOnly ? ' desktop-only' : ''}`}>
      <button
        ref={trigger}
        className="pw-model-pill"
        disabled={disabled}
        popoverTarget={id}
        aria-label={`Model and effort: ${name}${efforts.length ? ', ' + title(effort) : ''}`}
        onClick={() => {
          setPage(efforts.length ? 'effort' : 'models');
          position();
        }}
      >
        <span className="pw-model-name">{name}</span>
        {efforts.length > 0 && effort && <span className="pw-model-effort">{title(effort)}</span>}
        <WorkspaceIcon name="chevron-down" className="pw-control-chevron" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Model and effort"
        className="pw-model-popover"
        onToggle={(e) => {
          if (e.newState === 'open') {
            position();
            popup.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
      >
        {page === 'effort' ? (
          effortControls
        ) : page === 'models' ? (
          <>
            <div className="pw-popover-heading">
              {efforts.length > 0 && (
                <IconButton icon="back" label="Back to effort" onClick={() => setPage('effort')} />
              )}
              <span>Select model</span>
            </div>
            {modelChoices}
          </>
        ) : (
          customEditor
        )}
      </div>
    </div>
  );
}
