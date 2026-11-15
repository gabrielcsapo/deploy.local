'use client';
import { useEffect, useState } from 'react';
import { Action, Dialog, Field, Icon } from '@/components/ui';
import type { ArtifactKind } from '../../../../../shared/v2/artifacts';
import { getAuth } from '../../detail/shared';
import { request } from '../projects/data';
import { createNote, createdHref } from './model';

const titles: Record<ArtifactKind, string> = { design: 'New design', document: 'New document' };

/** A kind's tile asks for a name and the project; Create writes the files and opens them. */
export function NewArtifact({
  kind,
  projects,
  onClose,
}: {
  kind: ArtifactKind | null;
  projects: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A fresh dialog each time a kind is picked; the project list may arrive after it opens.
  useEffect(() => {
    if (!kind) return;
    setName('');
    setError('');
    setBusy(false);
  }, [kind]);
  useEffect(() => {
    if (!kind) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(`deploy.design.lastProject.${getAuth()?.username ?? ''}`);
    } catch {
      /* Storage is optional. */
    }
    setProject((current) =>
      projects.some((entry) => entry.id === current)
        ? current
        : ((projects.find((entry) => entry.id === last) ?? projects[0])?.id ?? ''),
    );
  }, [kind, projects]);
  const chosen = projects.find((entry) => entry.id === project);
  const create = async () => {
    if (!kind || !name.trim() || !project) return;
    setBusy(true);
    setError('');
    try {
      const made = await request<{
        projectId: string;
        artifact: string;
        kind: ArtifactKind;
        branch: string;
      }>('/api/artifacts', {
        method: 'POST',
        body: JSON.stringify({ kind, name, project }),
      });
      window.location.assign(createdHref(made));
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  const note = createNote(name, chosen?.name);
  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind ? titles[kind] : ''}
      className="af-dialog"
      actions={
        <>
          <Action onClick={onClose}>Cancel</Action>
          <Action
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !project}
            onClick={() => void create()}
          >
            Create
          </Action>
        </>
      }
    >
      <form
        className="af-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field
          label="Name"
          value={name}
          maxLength={80}
          required
          error={error || undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <div>
          <label className="dl-field-label" htmlFor="artifact-project">
            Project
          </label>
          <div className="dl-field af-select">
            <select
              id="artifact-project"
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <Icon name="down" size={14} />
          </div>
          {note && <p className="dl-meta af-note">{note}</p>}
        </div>
      </form>
    </Dialog>
  );
}
