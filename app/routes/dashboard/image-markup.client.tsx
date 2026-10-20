'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextField } from '@/components/ui';
import tokens from '@/design-tokens.json';
import { mediaFetch, uploadImage } from './attachments.client';
import { drawMarks } from './image-markup-canvas';
import { attachmentDraftKey, restoreAttachmentDraft, type Attachment } from './attachment-state';
import { getAuth } from './detail/shared';
import {
  changeMarks,
  emptyMarks,
  flattenSize,
  redoMarks,
  undoMarks,
  type MarkColor,
  type MarkPoint,
  type MarkShape,
  type MarkTool,
} from './image-markup';

export const markupAttachedEvent = 'deploy:markup-attached';
export function MarkupButton({ attachment, done }: { attachment: Attachment; done?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="link" onClick={() => setOpen(true)}>
        Mark up
      </Button>
      {open && (
        <ImageMarkup
          attachment={attachment}
          cancel={() => setOpen(false)}
          done={() => {
            setOpen(false);
            done?.();
          }}
        />
      )}
    </>
  );
}
function ImageMarkup({
  attachment,
  cancel,
  done,
}: {
  attachment: Attachment;
  cancel: () => void;
  done: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement>();
  const [history, setHistory] = useState(emptyMarks),
    [tool, setTool] = useState<MarkTool>('pen');
  const [color, setColor] = useState<MarkColor>('accent'),
    [width, setWidth] = useState(tokens.size.markupMedium);
  const [label, setLabel] = useState(''),
    [active, setActive] = useState<MarkShape>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<MarkShape | undefined>(undefined);
  const pointer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let valid = true;
    let url = '';
    void mediaFetch(`/api/workspace/attachments/${attachment.id}`)
      .then((r) => r.blob())
      .then(async (blob) => {
        if (!valid) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        await img.decode();
        if (valid) setImage(img);
      })
      .catch((e) => {
        if (valid) setError(e.message);
      });
    return () => {
      element?.close();
      valid = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id]);
  const paint = useCallback(
    (target: HTMLCanvasElement, shapes: MarkShape[]) => {
      const colors = Object.fromEntries(
        (['accent', 'statusAttention', 'statusFailed'] as const).map((key) => [
          key,
          getComputedStyle(dialog.current!).getPropertyValue(`--ds-${key}`).trim(),
        ]),
      ) as Record<MarkColor, string>;
      if (!image) return;
      const size = flattenSize(image.naturalWidth, image.naturalHeight);
      target.width = size.width;
      target.height = size.height;
      const ctx = target.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.drawImage(image, 0, 0);
      drawMarks(
        ctx,
        shapes,
        colors,
        tokens.size.mediaViewerHeight,
        tokens.type.phoneBody,
        tokens.fontFamily,
      );
    },
    [image],
  );
  useEffect(() => {
    if (canvas.current && image)
      paint(canvas.current, [...history.shapes, ...(active ? [active] : [])]);
  }, [image, history, active, paint]);
  function point(e: React.PointerEvent<HTMLCanvasElement>): MarkPoint {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  async function attach() {
    if (!image || busy) return;
    setBusy(true);
    setError('');
    try {
      const draftKey = attachmentDraftKey(getAuth()?.username || '', attachment.taskId);
      if (restoreAttachmentDraft(localStorage.getItem(draftKey)).length >= 20)
        throw new Error('At most 20 images per message');
      const output = document.createElement('canvas');
      paint(output, history.shapes);
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Could not create PNG'))),
          'image/png',
        ),
      );
      if (blob.size > 20 * 1024 * 1024) throw new Error('Marked-up image exceeds 20 MB');
      const uploaded = await uploadImage(
        attachment.taskId,
        new File([blob], `marked-up-${attachment.name}.png`, { type: 'image/png' }),
        `Marked-up ${attachment.name}`,
      );
      window.dispatchEvent(new CustomEvent(markupAttachedEvent, { detail: uploaded }));
      done();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="pw-media-viewer pw-markup"
      aria-label={`Mark up ${attachment.name}`}
      aria-busy={busy}
      onClose={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!busy) cancel();
      }}
    >
      <div className="pw-media-toolbar">
        <Button variant="primary" disabled={!image || busy} onClick={() => void attach()}>
          {busy ? 'Uploading…' : 'Attach to message'}
        </Button>
        <Button variant="link" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
      <div className="pw-media-toolbar" role="group" aria-label="Drawing tools">
        {(['pen', 'arrow', 'rectangle', 'text'] as const).map((t) => (
          <Button
            key={t}
            variant="link"
            aria-pressed={tool === t}
            disabled={busy}
            onClick={() => setTool(t)}
          >
            {t === 'text' ? 'Text label' : t[0].toUpperCase() + t.slice(1)}
          </Button>
        ))}
        <Button
          variant="link"
          disabled={busy || !history.undo.length}
          onClick={() => setHistory(undoMarks)}
        >
          Undo
        </Button>
        <Button
          variant="link"
          disabled={busy || !history.redo.length}
          onClick={() => setHistory(redoMarks)}
        >
          Redo
        </Button>
        <Button
          variant="link"
          disabled={busy || !history.shapes.length}
          onClick={() => setHistory((h) => changeMarks(h, []))}
        >
          Clear
        </Button>
      </div>
      <div className="pw-media-toolbar" role="group" aria-label="Drawing style">
        {(['accent', 'statusAttention', 'statusFailed'] as const).map((c, i) => (
          <Button
            key={c}
            variant="link"
            aria-pressed={color === c}
            disabled={busy}
            onClick={() => setColor(c)}
          >
            {['Accent', 'Attention', 'Failed'][i]}
          </Button>
        ))}
        {[tokens.size.markupFine, tokens.size.markupMedium, tokens.size.markupBroad].map((w, i) => (
          <Button
            key={w}
            variant="link"
            aria-pressed={width === w}
            disabled={busy}
            onClick={() => setWidth(w)}
          >
            {['Fine', 'Medium', 'Broad'][i]}
          </Button>
        ))}
        {tool === 'text' && (
          <TextField
            label="Text label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!image && !error && <p role="status">Loading image…</p>}
      <div className="pw-markup-stage">
        <canvas
          ref={canvas}
          aria-label="Draw on image"
          onPointerDown={(e) => {
            if (
              !image ||
              busy ||
              pointer.current !== undefined ||
              (tool === 'text' && !label.trim())
            )
              return;
            pointer.current = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            const s: MarkShape = {
              tool,
              color,
              width,
              points: [point(e)],
              ...(tool === 'text' ? { text: label } : {}),
            };
            pending.current = s;
            setActive(s);
          }}
          onPointerMove={(e) => {
            const s = pending.current;
            if (!s || pointer.current !== e.pointerId) return;
            const next = {
              ...s,
              points: s.tool === 'pen' ? [...s.points, point(e)] : [s.points[0], point(e)],
            };
            pending.current = next;
            setActive(next);
          }}
          onPointerUp={(e) => {
            if (pointer.current !== e.pointerId) return;
            if (pending.current) {
              const s = pending.current;
              setHistory((h) => changeMarks(h, [...h.shapes, s]));
            }
            pending.current = undefined;
            pointer.current = undefined;
            setActive(undefined);
          }}
          onPointerCancel={(e) => {
            if (pointer.current !== e.pointerId) return;
            pending.current = undefined;
            pointer.current = undefined;
            setActive(undefined);
          }}
        />
      </div>
    </dialog>
  );
}
