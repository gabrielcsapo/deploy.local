import type { SVGProps } from 'react';

type BrandSvgProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  title?: string;
};

/**
 * The responsive signature used only where the full wordmark cannot survive.
 * Its heavier first route hands off to a quieter second route through the same
 * cyan square that punctuates `deploy.local`.
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
      <path className="brand-signature-deploy" d="M8 22h39" />
      <rect className="brand-signature-dot" x="8" y="38" width="7" height="7" rx="1.4" />
      <path className="brand-signature-local" d="M21 42h35" />
    </svg>
  );
}

/**
 * The primary identity is the domain itself. Every letter is constructed from
 * a single rounded route radius; `deploy` carries more weight than `.local`.
 */
export function BrandWordmark({ className = '', title, ...props }: BrandSvgProps) {
  return (
    <svg
      viewBox="0 0 330 64"
      className={`brand-wordmark ${className}`}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <g className="brand-wordmark-deploy">
        <path d="M27 7v40M27 25c-3-4-7-6-11-6C8.8 19 4 25 4 33s4.8 14 12 14c4 0 8-2.2 11-6" />
        <path d="M37 34h22c0-9-4.4-15-11.2-15C40.5 19 36 25.2 36 33s5.1 14 13.2 14c3.8 0 7.1-1 9.8-3.5" />
        <path d="M68 20v37M68 25c3-4 6.5-6 10.5-6C86 19 91 25 91 33s-5 14-12.5 14c-4 0-7.5-2.2-10.5-6" />
        <path d="M101 7v40" />
        <path d="M123 19c-7.5 0-12 5.6-12 14s4.5 14 12 14 12-5.6 12-14-4.5-14-12-14Z" />
        <path d="m143 21 10 24m14-24-15 36" />
      </g>
      <rect className="brand-wordmark-dot" x="181" y="40" width="7" height="7" rx="1.4" />
      <g className="brand-wordmark-local" transform="translate(198)">
        <path d="M4 7v40" />
        <path d="M26 19c-7.5 0-12 5.6-12 14s4.5 14 12 14 12-5.6 12-14-4.5-14-12-14Z" />
        <path d="M67 23c-2.5-2.5-5.6-4-9.5-4C50 19 45 24.6 45 33s5 14 12.5 14c3.9 0 7-1.4 9.5-4" />
        <path d="M98 25c-3-4-7-6-11-6-7.3 0-12 6-12 14s4.7 14 12 14c4 0 8-2 11-6m0-21v27" />
        <path d="M113 7v40" />
      </g>
    </svg>
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-lockup">
      <BrandWordmark />
      {!compact ? <span className="brand-lockup-kind">application cloud</span> : null}
    </span>
  );
}
