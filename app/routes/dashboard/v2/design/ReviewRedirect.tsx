'use client';
import { useEffect } from 'react';
import { reviewHref } from './review-model';

/** Old inbox and task review links keep their identity but open the Design canvas. */
export function ReviewRedirect({ item, href: to }: { item: string; href?: string }) {
  const href = to ?? reviewHref(item);
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return (
    <a className="dl-btn secondary" href={href}>
      Open in Design
    </a>
  );
}
