'use client';
import { useAgentIdentity } from '../data/hooks';
import { useState, type CSSProperties } from 'react';
import { Action, Dialog } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import type { AgentAvatar as Identity } from '../../../../../shared/v2/contracts';
import { agentColors, agentGlyphs, randomAgentAvatar } from '../../../../../shared/v2/agents';
const colorNames = [
  'Violet',
  'Blue',
  'Green',
  'Amber',
  'Red',
  'Indigo',
  'Teal',
  'Orange',
  'Pink',
  'Gray',
];
export function AgentColors({
  value,
  onChange,
}: {
  value: Identity;
  onChange: (value: Identity) => void;
}) {
  return (
    <div className="dl-agent-colors" aria-label="Color">
      {agentColors.map((color, i) => (
        <button
          type="button"
          key={color}
          aria-label={colorNames[i]}
          aria-pressed={value.color === color}
          style={{ '--agent-color': color } as CSSProperties}
          onClick={() => onChange({ ...value, color })}
        >
          <span />
        </button>
      ))}
    </div>
  );
}
export function AgentIdentity({
  value,
  onChange,
  creating = false,
}: {
  value: Identity;
  onChange: (value: Identity) => void;
  creating?: boolean;
}) {
  const [draft, setDraft] = useState<Identity | null>(null);
  return (
    <>
      <div className="dl-agent-avatar-edit">
        <button type="button" className="dl-agent-avatar-choice" onClick={() => setDraft(value)}>
          <AgentAvatar avatar={value} size={88} />
          <span className="dl-meta">{creating ? 'Choose avatar' : 'Change avatar'}</span>
        </button>
        <Action variant="quiet" onClick={() => onChange(randomAgentAvatar())}>
          Shuffle
        </Action>
      </div>
      <AgentColors value={value} onChange={onChange} />
      <Dialog
        open={!!draft}
        onClose={() => setDraft(null)}
        title="Choose avatar"
        actions={
          <Action
            variant="primary"
            onClick={() => {
              if (draft) onChange(draft);
              setDraft(null);
            }}
          >
            Done
          </Action>
        }
      >
        {draft && (
          <>
            <div className="dl-agent-glyphs">
              {agentGlyphs.map((glyph) => (
                <button
                  type="button"
                  key={glyph}
                  aria-label={glyph}
                  data-dialog-focus={draft.glyph === glyph ? true : undefined}
                  aria-pressed={draft.glyph === glyph}
                  onClick={() => setDraft({ ...draft, glyph })}
                >
                  <AgentAvatar avatar={{ ...draft, glyph }} size={44} />
                </button>
              ))}
            </div>
            <p className="dl-meta">Color</p>
            <AgentColors value={draft} onChange={setDraft} />
          </>
        )}
      </Dialog>
    </>
  );
}

export function SavedAgentAvatar({ id }: { id: string }) {
  const identities = useAgentIdentity();
  return <AgentAvatar id={id} avatar={identities[id]} />;
}
