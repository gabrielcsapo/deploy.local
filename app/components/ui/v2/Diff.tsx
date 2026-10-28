'use client';
import { type ComponentState, stateProps, Icon } from './shared';
export type DiffLine = { kind?: 'add' | 'del' | 'hunk'; old?: number; new?: number; text: string };
export function Diff({
  file,
  lines,
  disabled,
  loading,
}: ComponentState & { file: string; lines: DiffLine[] }) {
  return (
    <section className="dl-source" {...stateProps({ disabled, loading })}>
      <div className="dl-source-head">
        <Icon name="file" />
        {file}
        <span className="dl-end">
          <span className="dl-add">+{lines.filter((line) => line.kind === 'add').length}</span>{' '}
          <span className="dl-del">−{lines.filter((line) => line.kind === 'del').length}</span>
        </span>
      </div>
      <div
        className="dl-lines"
        role="region"
        aria-label={`Changes to ${file}`}
        tabIndex={disabled ? undefined : 0}
      >
        {lines.map((line, index) => (
          <div className={`dl-line ${line.kind || ''}`} key={index}>
            <span className="dl-n" aria-label="Old line">
              {line.old}
            </span>
            <span className="dl-n" aria-label="New line">
              {line.new}
            </span>
            <code>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              {line.text}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}
