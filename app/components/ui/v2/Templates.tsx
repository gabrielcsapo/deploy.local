'use client';
import type { ReactNode } from 'react';
import { Head } from './Head';
import { Tabs, type TabItem } from './Tabs';
import { Icon, IconButton } from './shared';
import './templates.css';

/**
 * The four page templates from the design system (Assets › Page templates; boards TemplateList,
 * TemplateDetail, TemplateConversation and TemplateSettings). A new page picks one and fills it;
 * the shell around it (sidebar, main pane) stays the app's.
 */

/** The header's menu button: below 820 px it opens the sidebar. */
function MenuButton() {
  return (
    <IconButton
      icon="menu"
      label="Show sidebar"
      className="dl-menu-btn"
      onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
    />
  );
}

type Sections = { items: TabItem[]; value: string; label?: string };

/**
 * A page that lists one kind of thing: the header, then (when it has a description or actions)
 * the page title with what the list is for and its actions, optional tabs, then groups of rows.
 */
export function ListTemplate({
  title,
  subtitle,
  description,
  actions,
  headerActions,
  tabs,
  ruled = true,
  className = '',
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** What the list is for, under the page title. */
  description?: ReactNode;
  /** Beside the page title: the primary action last. */
  actions?: ReactNode;
  /** At the end of the header. */
  headerActions?: ReactNode;
  tabs?: Sections;
  ruled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head
        title={title}
        subtitle={subtitle}
        menu={<MenuButton />}
        actions={headerActions}
        ruled={ruled}
      />
      <div className="dl-scroll">
        <div className={`dl-page ${className}`}>
          {(description || actions) && (
            <div className="dl-page-head">
              <div className="dl-t">
                <h1 className="dl-title">{title}</h1>
                {description && <span className="dl-meta">{description}</span>}
              </div>
              {actions && <span className="dl-end">{actions}</span>}
            </div>
          )}
          {tabs && <Tabs {...tabs} />}
          {children}
        </div>
      </div>
    </>
  );
}

/**
 * One thing from a list: a breadcrumb back to the list, one primary action, its sections as tabs,
 * then sections of rows.
 */
export function DetailTemplate({
  title,
  subtitle,
  parent,
  actions,
  tabs,
  className = '',
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The list this belongs to; the header starts with a breadcrumb back to it. */
  parent?: { label: string; href: string };
  actions?: ReactNode;
  tabs?: Sections;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head
        title={
          parent ? (
            <nav className="dl-crumbs" aria-label="Breadcrumb">
              <a href={parent.href} className="dl-crumb">
                {parent.label}
              </a>
              <Icon name="chevron" size={14} className="dl-crumb-sep" />
              <span aria-current="page">{title}</span>
            </nav>
          ) : (
            title
          )
        }
        subtitle={subtitle}
        menu={<MenuButton />}
        actions={actions}
      />
      <div className="dl-scroll">
        <div className={`dl-page ${tabs ? 'dl-page-tabbed' : ''} ${className}`}>
          {tabs && <Tabs {...tabs} />}
          {children}
        </div>
      </div>
    </>
  );
}

/**
 * Talking with an agent about one piece of work: the title and its one decision in the header,
 * views as tabs, the thread in the reading column and the composer at the foot.
 */
export function ConversationTemplate({
  title,
  actions,
  tabs,
  composer,
  children,
}: {
  title: ReactNode;
  /** The header's end: More, then the one decision. */
  actions?: ReactNode;
  tabs?: Sections;
  /** Usually <Composer />, docked at the foot of the column. */
  composer?: ReactNode;
  /** The thread: your messages, work logs, replies and decisions. */
  children: ReactNode;
}) {
  return (
    <>
      <Head title={title} menu={<MenuButton />} actions={actions} ruled />
      <div className="dl-scroll">
        <div className="dl-col">
          {tabs && <Tabs label="Task" {...tabs} />}
          <div className="dl-thread">{children}</div>
        </div>
      </div>
      {composer && <div className="dl-dock">{composer}</div>}
    </>
  );
}

/**
 * Settings for one place: its sections listed on the left, and labelled groups of setting rows.
 * Explanations go below a group (SettingsList's note).
 */
export function SettingsTemplate({
  title,
  sections,
  children,
}: {
  title: string;
  /** The sections, as <Nav> links; the current one is active. */
  sections?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <Head title={title} menu={<MenuButton />} />
      <div className="dl-scroll">
        <div className="dl-page dl-page-settings">
          {sections && (
            <nav aria-label="Sections" className="dl-settings-nav">
              {sections}
            </nav>
          )}
          <div className="dl-settings-content">{children}</div>
        </div>
      </div>
    </>
  );
}
