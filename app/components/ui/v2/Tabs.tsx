'use client';
import { useEffect, useRef, useState } from 'react';
import { type ComponentState, stateProps } from './shared';
export type TabItem = { label: string; href: string; count?: number; disabled?: boolean };
export function Tabs({
  items,
  value,
  label = 'Sections',
  disabled,
  loading,
}: ComponentState & { items: TabItem[]; value: string; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const signature = items.map((item) => `${item.href}:${item.count}`).join('|');
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const update = () => setMore(nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 1);
    const reveal = () => {
      const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
      // Scroll the strip only, never the page containing it.
      if (current) {
        const item = current.getBoundingClientRect(),
          strip = nav.getBoundingClientRect();
        if (item.left < strip.left) nav.scrollLeft -= strip.left - item.left;
        else if (item.right > strip.right - 32 && nav.scrollWidth > nav.clientWidth)
          nav.scrollLeft = Math.min(
            nav.scrollWidth - nav.clientWidth,
            nav.scrollLeft + item.right - strip.right + 32,
          );
      }
      update();
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    nav.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      nav.removeEventListener('scroll', update);
    };
  }, [value, signature]);
  return (
    <nav
      ref={ref}
      data-more={more}
      className="dl-tabs"
      aria-label={label}
      {...stateProps({ disabled, loading })}
    >
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
