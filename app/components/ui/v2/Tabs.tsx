'use client';
import { type ComponentState, stateProps } from './shared';
export type TabItem = { label: string; href: string; count?: number; disabled?: boolean };
export function Tabs({
  items,
  value,
  label = 'Sections',
  disabled,
  loading,
}: ComponentState & { items: TabItem[]; value: string; label?: string }) {
  return (
    <nav className="dl-tabs" aria-label={label} {...stateProps({ disabled, loading })}>
      {items.map((item) => (
        <a
          key={item.href}
          href={item.disabled ? undefined : item.href}
          aria-disabled={item.disabled || undefined}
          aria-current={value === item.href ? 'page' : undefined}
          className={value === item.href ? 'on' : ''}
        >
          {item.label}
          {item.count !== undefined && <span className="dl-n">{item.count}</span>}
        </a>
      ))}
    </nav>
  );
}
