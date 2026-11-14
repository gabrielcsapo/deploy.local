'use client';
import type { ReactNode } from 'react';
import { Head, IconButton, Group, Icon } from '@/components/ui';
import { authenticatedFetch } from '../data/hooks';
export async function request(path: string, method = 'GET', body?: unknown) {
  const response = await authenticatedFetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed. Try again.');
  return result;
}
export function AgentHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <Head
      title={title}
      subtitle={subtitle}
      actions={actions}
      menu={
        <IconButton
          icon="menu"
          label="Show sidebar"
          className="dl-menu-btn"
          onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
        />
      }
    />
  );
}
export function Elsewhere({ name }: { name: string }) {
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Set elsewhere</h2>
      <p className="dl-section-sub">Shared with every agent, so they are set in one place.</p>
      <Group>
        <a className="dl-item" href="/dashboard/settings/approvals">
          <Icon name="check" />
          <span className="dl-t">
            <span>What {name} may do</span>
            <span>From the Approvals table · starts with every action set to Ask me</span>
          </span>
          <Icon name="chevron" />
        </a>
        <a className="dl-item" href="/dashboard/computers/models">
          <Icon name="settings" />
          <span className="dl-t">
            <span>Which models {name} uses</span>
            <span>Defaults on Computers › Models</span>
          </span>
          <Icon name="chevron" />
        </a>
      </Group>
    </section>
  );
}
