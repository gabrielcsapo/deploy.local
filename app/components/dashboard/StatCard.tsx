'use client';

import type { ReactNode } from 'react';
import { MiniSparkline } from './Sparkline';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'accent';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  trend?: 'up' | 'down' | 'flat';
  sparkline?: { data: number[]; color?: string };
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  /** "hero" promotes this card: bigger value, deeper bg, no border — one per page. */
  variant?: 'default' | 'hero';
}

const toneRing: Record<StatTone, string> = {
  default: '',
  success: 'ring-1 ring-success/25',
  warning: 'ring-1 ring-warning/30',
  danger: 'ring-1 ring-danger/35',
  accent: 'ring-1 ring-accent/35',
};

const toneDot: Record<StatTone, string> = {
  default: 'bg-text-tertiary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
};

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'default',
  trend,
  sparkline,
  onClick,
  selected = false,
  className = '',
  variant = 'default',
}: StatCardProps) {
  const interactive = !!onClick;
  const Comp = interactive ? 'button' : 'div';
  const sparkColor =
    sparkline?.color ??
    (tone === 'danger'
      ? 'var(--color-danger)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : tone === 'success'
          ? 'var(--color-success)'
          : 'var(--color-accent)');

  const isHero = variant === 'hero';
  const hasSpark = sparkline && sparkline.data.length > 1;
  const minH = isHero ? 'min-h-[140px]' : hasSpark ? 'min-h-[108px]' : 'min-h-[68px]';
  // Keep value text neutral. The brand gradient only paints the sparkline
  // fill for accent-toned cards — using it on numerals semantically
  // overloaded "Requests" as more important than "Errors" which is the
  // opposite of what an operator wants to see.
  const wantsBrandSpark = isHero || tone === 'accent';

  return (
    <Comp
      onClick={onClick}
      type={interactive ? 'button' : undefined}
      aria-pressed={interactive ? selected : undefined}
      className={`relative ${isHero ? 'card-hero p-4 sm:p-5' : 'card p-3 sm:p-4'} text-left flex flex-col gap-1 ${minH} ${toneRing[tone]} ${
        interactive
          ? 'cursor-pointer hover:border-border-hover transition-all duration-200 active:bg-bg-hover hover:shadow-[0_0_0_1px_hsl(266_90%_66%/0.18),0_8px_28px_-12px_hsl(266_90%_50%/0.4)]'
          : ''
      } ${selected ? 'ring-1 ring-accent/40' : ''} ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon && <span className="text-text-tertiary shrink-0">{icon}</span>}
          <p className="eyebrow truncate">{label}</p>
        </div>
        {tone !== 'default' && (
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${toneDot[tone]}`}
            aria-hidden
          />
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <p
          className={`font-mono font-semibold leading-tight tabular-nums ${
            isHero ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'
          }`}
        >
          {value}
        </p>
        {trend && (
          <span
            className={`text-xs font-mono ${
              trend === 'up'
                ? 'text-success'
                : trend === 'down'
                  ? 'text-danger'
                  : 'text-text-tertiary'
            }`}
            aria-hidden
          >
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '·'}
          </span>
        )}
      </div>
      {sub && <div className="text-[11px] text-text-secondary leading-tight">{sub}</div>}
      {hasSpark && (
        <div className="mt-auto pt-2 -mx-1">
          <MiniSparkline
            data={sparkline.data}
            color={sparkColor}
            height={isHero ? 44 : 30}
            gradient={wantsBrandSpark}
          />
        </div>
      )}
    </Comp>
  );
}
