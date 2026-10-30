'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/ui/v2/shared';
import './fonts.css';
import './header.css';

export const sourceUrl = 'https://github.com/gabrielcsapo/deploy.local';
export type PublicSection = 'about' | 'docs' | 'changelog';
export const publicLinks: { section?: PublicSection; label: string; href: string; end?: string }[] =
  [
    { section: 'about', label: 'About', href: '/about' },
    { section: 'docs', label: 'Docs', href: '/docs' },
    { section: 'changelog', label: 'Changelog', href: '/changelog' },
    { label: 'Source', href: sourceUrl, end: 'GitHub' },
  ];

/**
 * The one header on every signed-out page. Below the phone breakpoint the links move into a
 * menu beside a quiet Sign in. Docs collapse it below the tablet breakpoint instead, where its
 * page list leaves the sidebar, and add that list to the menu after the site links.
 */
export function PublicHeader({
  current,
  wide = false,
  collapse = 'phone',
  menuExtra,
}: {
  current?: PublicSection;
  wide?: boolean;
  collapse?: 'phone' | 'tablet';
  menuExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('a')?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', pointerdown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', pointerdown);
    };
  }, [open]);

  return (
    <header
      ref={header}
      className={collapse === 'tablet' ? 'site-header collapse-tablet' : 'site-header'}
      onBlur={(event) => {
        if (open && !header.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className={`site-header-bar ${wide ? 'wide' : ''}`}>
        <a className="site-brand" href="/">
          <span className="dl-mark">d</span>
          <span>deploy.local</span>
        </a>
        <nav className="site-nav" aria-label="Site">
          {publicLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              aria-current={link.section && link.section === current ? 'page' : undefined}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <a className="dl-btn secondary site-signin" href="/signin">
          Sign in
        </a>
        <button
          ref={button}
          type="button"
          className="dl-icon-btn site-menu-btn"
          aria-label={open ? 'Close menu' : 'Menu'}
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen(!open)}
        >
          <Icon name="menu" />
        </button>
      </div>
      {open && <div className="site-menu-scrim" aria-hidden="true" />}
      <nav
        ref={menu}
        id={menuId}
        className={menuExtra ? 'dl-menu site-menu has-extra' : 'dl-menu site-menu'}
        aria-label="Site menu"
        hidden={!open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false);
        }}
      >
        {publicLinks.map((link) => {
          const here = link.section && link.section === current;
          return (
            <a
              key={link.label}
              href={link.href}
              // With a page list below, only the current page is highlighted, as on the board.
              className={here && !menuExtra ? 'dl-menu-item on' : 'dl-menu-item'}
              aria-current={here ? 'page' : undefined}
            >
              {link.label}
              {link.end && <span className="dl-end">{link.end}</span>}
            </a>
          );
        })}
        {menuExtra && (
          <>
            <hr className="site-menu-rule" />
            {menuExtra}
          </>
        )}
      </nav>
    </header>
  );
}
