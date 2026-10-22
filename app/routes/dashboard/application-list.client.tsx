'use client';
import { useState } from 'react';
import {
  Button,
  IconLink,
  ListRow,
  OverflowMenu,
  StatusBadge,
  type StatusTone,
} from '../../components/ui';
import type { AppCardData, Severity } from '../../components/dashboard/AppCard';
import { appUrl } from './detail/shared';
const tones: Record<Severity, StatusTone> = {
  healthy: 'healthy',
  idle: 'healthy',
  building: 'active',
  down: 'failed',
  degraded: 'attention',
};
const labels: Record<Severity, string> = {
  healthy: 'Running',
  idle: 'Running',
  building: 'Building',
  down: 'Down',
  degraded: 'Degraded',
};

export function ApplicationList({
  cards,
  onDelete,
  onBulkRestart,
  onBulkDelete,
}: {
  cards: AppCardData[];
  onDelete: (name: string) => void;
  onBulkRestart: (names: string[]) => void;
  onBulkDelete: (names: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const names = selected.filter((name) => cards.some((card) => card.name === name));
  return (
    <section aria-label="Applications">
      <div className="ui-list-header">
        <Button
          variant="link"
          aria-pressed={editing}
          onClick={() => {
            setEditing(!editing);
            setSelected([]);
          }}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
        {editing && (
          <Button variant="link" onClick={() => setSelected(cards.map((card) => card.name))}>
            Select all
          </Button>
        )}
        {!!names.length && (
          <>
            <span>{names.length} selected</span>
            <Button variant="link" onClick={() => onBulkRestart(names)}>
              Restart selected
            </Button>
            <OverflowMenu label="Selected application actions">
              <Button
                variant="link"
                className="ds-danger-link"
                data-dismiss-menu
                onClick={() => onBulkDelete(names)}
              >
                Delete selected
              </Button>
            </OverflowMenu>
          </>
        )}
      </div>
      {[...cards]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((card) => (
          <ListRow
            key={card.name}
            to={`/dashboard/${encodeURIComponent(card.name)}`}
            icon="grid"
            title={card.name}
            secondary={appUrl(card.name)}
            status={
              card.severity !== 'healthy' && card.severity !== 'idle' ? (
                <StatusBadge tone={tones[card.severity]} label={labels[card.severity]} />
              ) : undefined
            }
            selection={
              editing ? (
                <input
                  type="checkbox"
                  aria-label={`Select ${card.name}`}
                  checked={names.includes(card.name)}
                  onChange={() =>
                    setSelected(
                      names.includes(card.name)
                        ? names.filter((name) => name !== card.name)
                        : [...names, card.name],
                    )
                  }
                />
              ) : undefined
            }
            actions={
              <IconLink
                icon="external"
                label={`Open ${card.name} in a new window`}
                href={appUrl(card.name)}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
            menu={
              <Button
                variant="link"
                className="ds-danger-link"
                data-dismiss-menu
                onClick={() => onDelete(card.name)}
              >
                Delete application
              </Button>
            }
          />
        ))}
    </section>
  );
}
