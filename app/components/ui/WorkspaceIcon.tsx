import { createElement } from 'react';
import icons from '../../workspace-icons.json';

export type WorkspaceIconName = keyof typeof icons.glyphs;

export function WorkspaceIcon({ name, className = '' }: { name: string; className?: string }) {
  const shapes = icons.glyphs[name as WorkspaceIconName];
  return (
    <svg
      className={`pw-icon ${className}`}
      width="18"
      height="18"
      viewBox={`0 0 ${icons.viewBox} ${icons.viewBox}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={icons.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes?.map(({ tag, ...attributes }, index) =>
        createElement(tag, { key: index, ...attributes }),
      )}
    </svg>
  );
}
