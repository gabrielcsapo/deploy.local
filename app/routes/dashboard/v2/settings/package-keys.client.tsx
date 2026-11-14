'use client';
import { useState } from 'react';
import { Action, Banner, Group, Icon } from '@/components/ui';
import { request, useData } from '../projects/data';
import { formatTime } from '../data/time';
export function PackageKeys() {
  const { data, error, refresh } = useData<{
    keys: { id: string; label: string; scope: string; lastUsedAt: string | null }[];
  }>('/api/package-keys');
  const [failure, setFailure] = useState('');
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Package keys</h2>
      <p className="dl-section-sub">
        For npm and pnpm on your computers. deploy packages login makes one.
      </p>
      {(error || failure) && <Banner kind="danger" title={error || failure} />}
      <Group>
        {data?.keys.map((key) => (
          <div className="dl-item" key={key.id}>
            <Icon name="package" />
            <span className="dl-t">
              <span>{key.label}</span>
              <span>
                {key.scope === 'publish' ? 'Installs and publishes' : 'Installs only'} ·{' '}
                {key.lastUsedAt
                  ? 'used ' + formatTime(key.lastUsedAt).toLowerCase()
                  : 'not used yet'}
              </span>
            </span>
            <Action
              variant="quiet"
              onClick={async () => {
                try {
                  await request('/api/package-keys', {
                    method: 'DELETE',
                    body: JSON.stringify({ id: key.id }),
                  });
                  refresh();
                } catch (error: any) {
                  setFailure(error.message);
                }
              }}
            >
              Remove
            </Action>
          </div>
        ))}
      </Group>
    </section>
  );
}
