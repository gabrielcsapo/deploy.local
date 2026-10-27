/** Placeholders describe layout only; mount only while the requested data has never loaded. */
export function Skeleton({
  variant = 'rows',
  label = 'Loading',
  rows = 5,
}: {
  variant?: 'rows' | 'sidebar' | 'conversation' | 'detail' | 'chip';
  label?: string;
  rows?: number;
}) {
  // A chip stands in for one inline label, so it is a single placeholder rather than a stack.
  const count = variant === 'conversation' ? 3 : variant === 'chip' ? 1 : rows;
  return (
    <div
      className={`ui-skeleton ui-skeleton-${variant}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="ui-skeleton-block" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}
