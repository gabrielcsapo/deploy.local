'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Icon, IconButton } from '@/components/ui';
import type { Markup, Screenshot } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { safeResourceUrl } from '../conversation/model';
import { mediaRequest, submitMessage, uploadFile } from './client';
import { arrowHead, emptyMarkup, markupColors, paintMarkup } from './model';
import './style.css';

export function MarkupView({
  screenshot,
  onClose,
  initialText = '',
}: {
  screenshot: Screenshot;
  onClose: () => void;
  initialText?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [markup, setMarkup] = useState<Markup>(screenshot.markup || emptyMarkup());
  const [history, setHistory] = useState<Markup[]>([]);
  const [tool, setTool] = useState<'pen' | 'arrow' | 'text'>('pen');
  const [color, setColor] = useState<0 | 1 | 2>(0);
  const [size, setSize] = useState({ width: 390, height: 780 });
  const [draft, setDraft] = useState<Markup['strokes'][number] | null>(null);
  const [label, setLabel] = useState('');
  const [position, setPosition] = useState<[number, number]>([30, 60]);
  const [message, setMessage] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    let active = true,
      objectUrl = '';
    const safe = safeResourceUrl(screenshot.image);
    if (!safe) {
      setError('Screenshot unavailable');
      return;
    }
    authenticatedFetch(safe)
      .then(async (response) => {
        if (!response.ok) throw new Error('Screenshot unavailable');
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setSource(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [screenshot.image]);
  const commit = (next: Markup) => {
    setHistory((items) => [...items, markup]);
    setMarkup(next);
  };
  function point(event: PointerEvent<SVGSVGElement>): [number, number] {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      Math.max(
        0,
        Math.min(size.width, ((event.clientX - bounds.left) / bounds.width) * size.width),
      ),
      Math.max(
        0,
        Math.min(size.height, ((event.clientY - bounds.top) / bounds.height) * size.height),
      ),
    ];
  }
  async function send() {
    if (!message.trim() || !image.current || busy) return;
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image.current, 0, 0);
      paintMarkup(context, markup);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('Could not render markup'))),
          'image/png',
        ),
      );
      const attachment = await uploadFile(blob, 'screenshot-with-markup.png');
      await mediaRequest(`/screenshots/${encodeURIComponent(screenshot.id)}`, 'PATCH', {
        markup,
        renderedImage: attachment.ref,
      });
      await submitMessage({ text: message.trim(), attachments: [attachment] }, screenshot.taskId);
      window.dispatchEvent(new Event('deploy:conversation-changed'));
      onClose();
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const strokes = [...markup.strokes, ...(draft ? [draft] : [])];
  return (
    <dialog
      ref={dialog}
      className="dl-dialog dl-markup"
      aria-label="Mark up screenshot"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dl-markup-toolbar">
        <strong>Mark up</strong>
        {(['pen', 'arrow', 'text'] as const).map((value) => (
          <button
            type="button"
            className={`dl-icon-btn ${tool === value ? 'on' : ''}`}
            aria-label={value === 'text' ? 'Text' : value === 'pen' ? 'Pen' : 'Arrow'}
            aria-pressed={tool === value}
            key={value}
            onClick={() => setTool(value)}
            disabled={busy}
          >
            {value === 'text' ? 'Aa' : <Icon name={value === 'pen' ? 'compose' : 'send'} />}
          </button>
        ))}
        <button
          type="button"
          className="dl-icon-btn"
          aria-label="Undo"
          disabled={busy || !history.length}
          onClick={() => {
            setMarkup(history.at(-1)!);
            setHistory((items) => items.slice(0, -1));
          }}
        >
          <span aria-hidden="true">↶</span>
        </button>
        <div className="dl-markup-colors">
          {markupColors.map((value, i) => (
            <button
              type="button"
              key={value}
              style={{ background: value }}
              className={color === i ? 'on' : ''}
              aria-label={['Red', 'Yellow', 'Blue'][i]}
              aria-pressed={color === i}
              onClick={() => setColor(i as 0 | 1 | 2)}
              disabled={busy}
            />
          ))}
        </div>
        <span className="dl-meta dl-grow">
          {screenshot.target.device ||
            (size.width <= 700 ? 'iPhone size' : `Laptop · ${size.width} wide`)}
        </span>
        <IconButton icon="close" label="Close markup" disabled={busy} onClick={onClose} />
      </div>
      {tool === 'text' && (
        <form
          className="dl-markup-text"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim()) {
              commit({
                ...markup,
                texts: [
                  ...markup.texts,
                  { x: position[0], y: position[1], text: label.trim(), color },
                ],
              });
              setLabel('');
            }
          }}
        >
          <label>
            Text{' '}
            <input
              value={label}
              maxLength={500}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Click the image to place text"
            />
          </label>
          <button className="dl-btn secondary" disabled={!label.trim() || busy}>
            Add text
          </button>
        </form>
      )}
      <div className="dl-markup-stage">
        <div
          className="dl-markup-image"
          style={{
            aspectRatio: `${size.width}/${size.height}`,
            width: size.width <= 700 ? 260 : '100%',
          }}
        >
          <img
            ref={image}
            src={source || undefined}
            alt="Screenshot to mark up"
            onLoad={() => {
              if (image.current)
                setSize({ width: image.current.naturalWidth, height: image.current.naturalHeight });
            }}
          />
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-label="Draw on screenshot"
            role="img"
            onPointerDown={(event) => {
              if (busy || !source) return;
              if (tool === 'text') {
                setPosition(point(event));
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraft({ tool, color, points: [point(event)] });
            }}
            onPointerMove={(event) => {
              if (draft && draft.points.length < 5000)
                setDraft({ ...draft, points: [...draft.points, point(event)] });
            }}
            onPointerUp={() => {
              if (draft && draft.points.length > 1)
                commit({ ...markup, strokes: [...markup.strokes, draft] });
              setDraft(null);
            }}
            onPointerCancel={() => setDraft(null)}
          >
            {strokes.map((stroke, i) => (
              <g
                key={i}
                fill="none"
                stroke={markupColors[stroke.color]}
                strokeWidth={5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline
                  points={(stroke.tool === 'arrow'
                    ? [stroke.points[0], stroke.points.at(-1)!]
                    : stroke.points
                  )
                    .map((p) => p.join(','))
                    .join(' ')}
                />
                {stroke.tool === 'arrow' && (
                  <polyline
                    points={arrowHead(stroke.points)
                      .map((p) => p.join(','))
                      .join(' ')}
                  />
                )}
              </g>
            ))}
            {markup.texts.map((text, i) => (
              <text
                key={i}
                x={text.x}
                y={text.y}
                fill={markupColors[text.color]}
                stroke="white"
                strokeWidth={8}
                paintOrder="stroke"
                fontFamily="sans-serif"
                fontSize={30}
              >
                {text.text}
              </text>
            ))}
          </svg>
        </div>
      </div>
      <div className="dl-markup-footer">
        {error && (
          <p role="alert" className="dl-field-error">
            {error}
          </p>
        )}
        <form
          className="dl-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            aria-label="Follow-up message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask, build, or follow up…"
            disabled={busy}
          />
          <div className="dl-composer-bar">
            <span className="dl-chip">
              <Icon name="file" size={14} />
              Screenshot with {markup.strokes.length + markup.texts.length} marks
            </span>
            <span className="dl-grow" />
            <button
              className="dl-send"
              aria-label="Send marked-up screenshot"
              disabled={busy || !message.trim() || !source}
            >
              <Icon name={busy ? 'running' : 'send'} />
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
