import type { SVGProps } from 'react';

type BrandSvgProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  title?: string;
};

/**
 * The deploy.local mark: a house carrying the deploy arrow, on the action
 * violet tile. Shipping to machines you own. Matches public/favicon.svg and
 * the native app icons; the rail uses the stroke `brand` workspace glyph.
 */
export function BrandMark({ className = '', title, ...props }: BrandSvgProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={`brand-symbol ${className}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <rect className="brand-symbol-tile" width="64" height="64" rx="14.3" />
      <path
        className="brand-symbol-house"
        d="M32 12L50 27.5V48.5Q50 51 47.5 51H16.5Q14 51 14 48.5V27.5Z"
      />
      <path className="brand-symbol-arrow" d="M32 44.5V30.5M25.8 36.5L32 30.3L38.2 36.5" />
    </svg>
  );
}
