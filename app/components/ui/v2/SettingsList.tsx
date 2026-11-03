'use client';
import type { ReactNode } from 'react';
import { Group } from './Group';
import { Icon } from './shared';
export function SettingsList({
  title,
  note,
  children,
  end,
}: {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  end?: ReactNode;
}) {
  return (
    <section className="dl-list">
      <div className="dl-group-head">
        {title}
        <span className="dl-end">{end}</span>
      </div>
      <Group>{children}</Group>
      {note && <p className="dl-list-note">{note}</p>}
    </section>
  );
}
export function SettingsRow({
  title,
  subtitle,
  lead,
  value,
  onClick,
  href,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  lead?: ReactNode;
  value?: ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  const content = (
    <>
      {lead}
      <span className="dl-t">
        <span>{title}</span>
        {subtitle && <span>{subtitle}</span>}
      </span>
      {value && <span className="dl-c">{value}</span>}
      {(onClick || href) && <Icon name="chevron" className="dl-chev" />}
    </>
  );
  return href ? (
    <a className="dl-item" href={href}>
      {content}
    </a>
  ) : onClick ? (
    <button type="button" className="dl-item" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="dl-item">{content}</div>
  );
}
