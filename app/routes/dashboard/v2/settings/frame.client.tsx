'use client';
import type { ReactNode } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Icon } from '@/components/ui';
import { AgentHead } from '../agents/shared';
import './style.css';

// Every Settings page sits in this frame, so moving between them keeps the list beside you.
const links = [
  ['General', '/dashboard/settings'],
  ['Account and SSH keys', '/dashboard/settings/account'],
  ['Agents and approvals', '/dashboard/settings/approvals'],
  ['Devices', '/dashboard/settings/devices'],
  ['Backups', '/dashboard/settings/backups'],
];
export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = useLocation().pathname.replace(/\/+$/, '');
  return (
    <>
      <AgentHead title="Settings" />
      <div className="dl-scroll">
        <div className="dl-page dl-agent-settings">
          <nav aria-label="Settings">
            {links.map(([label, href]) => (
              <a
                key={href}
                className={`dl-nav ${pathname === href ? 'on' : ''}`}
                aria-current={pathname === href ? 'page' : undefined}
                href={href}
              >
                <span className="dl-lead">
                  <Icon name="settings" />
                </span>
                <span className="dl-t">{label}</span>
              </a>
            ))}
          </nav>
          <div className="dl-agent-settings-content">{children}</div>
        </div>
      </div>
    </>
  );
}
