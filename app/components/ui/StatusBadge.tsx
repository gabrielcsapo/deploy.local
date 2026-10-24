'use client';

export type StatusTone = 'active' | 'attention' | 'healthy' | 'failed' | 'inactive';

/** Status always has a readable label; inactive uses an outlined dot. */
export function StatusBadge({
  tone,
  label,
  className = '',
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  const sentenceLabel = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <span className={`ui-status-badge ${className}`} data-tone={tone}>
      <span className="ui-status-dot" aria-hidden="true" />
      <span className="ui-status-label">{sentenceLabel}</span>
    </span>
  );
}

/** Deployment/container states; task execution has its own progress semantics. */
export function applicationStatusTone(status: string): StatusTone {
  if (['running', 'online', 'healthy', 'succeeded', 'success'].includes(status)) return 'healthy';
  if (['failed', 'error', 'crashed', 'degraded', 'down'].includes(status)) return 'failed';
  if (
    ['starting', 'building', 'uploading', 'backing-up', 'restoring', 'restarting'].includes(status)
  )
    return 'active';
  if (
    ['review', 'configuration-needed', 'configuration-required', 'ready-to-deploy'].includes(status)
  )
    return 'attention';
  return 'inactive';
}
