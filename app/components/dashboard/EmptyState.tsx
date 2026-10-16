import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ds-feedback ds-feedback-empty ${className}`} role="status">
      {icon && (
        <span className="ds-feedback-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ds-feedback-actions">{action}</div>}
    </div>
  );
}
