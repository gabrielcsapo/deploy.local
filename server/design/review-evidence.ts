import { inflateSync } from 'node:zlib';
import { layerChanges, layerSnippet } from './board-html.ts';
import type { DesignRect, DesignReviewScreen } from '../../shared/v2/contracts.ts';
import type { ReviewEvidence } from '../../shared/v2/design-review.ts';

type Render = { png: Buffer; boxes: Record<string, DesignRect>; words?: Record<string, string> };
const words = (html: string) =>
  html
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();

/** Chromium screenshots are 8-bit RGB/RGBA PNGs. Undo PNG filters before comparing pixels. */
export function pngPixels(png: Buffer) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
  if (png[24] !== 8 || !channels || png[28]) throw new Error('Unsupported PNG');
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0,
        c = y && x >= channels ? pixels[at - stride - channels] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const prediction =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? Math.floor((a + b) / 2)
              : filter === 4
                ? pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c
                : 0;
      pixels[at] = raw[y * (stride + 1) + x + 1] + prediction;
    }
  }
  return { width, height, channels, pixels };
}
export function compareReviewPixels(before: Buffer, after: Buffer, areas: DesignRect[]) {
  const a = pngPixels(before),
    b = pngPixels(after);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels)
    return { same: false, outsideSame: false };
  let same = true,
    outsideSame = true;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const at = (y * a.width + x) * a.channels;
      if (
        a.pixels[at] === b.pixels[at] &&
        a.pixels[at + 1] === b.pixels[at + 1] &&
        a.pixels[at + 2] === b.pixels[at + 2] &&
        (a.channels === 3 || a.pixels[at + 3] === b.pixels[at + 3])
      )
        continue;
      same = false;
      if (
        !areas.some(
          (r) =>
            x >= Math.floor(r.x) &&
            y >= Math.floor(r.y) &&
            x < Math.ceil(r.x + r.w) &&
            y < Math.ceil(r.y + r.h),
        )
      )
        outsideSame = false;
    }
  return { same, outsideSame };
}

export function reviewEvidence(
  screen: Pick<DesignReviewScreen, 'file' | 'title' | 'status' | 'changedSinceReview'>,
  before: string,
  after: string,
  renders?: { before: Render; after: Render },
  changeWords?: Record<string, string>,
): ReviewEvidence {
  if (!before || !after)
    return {
      ...screen,
      regions: [],
      nothingElse: false,
      seen: false,
      changeWords: Object.values(changeWords ?? {}).find(Boolean),
    };
  const changes = layerChanges(before, after, Infinity);
  const regionFor = (layer: string) => {
    const html = after.includes(`data-layer="${layer}"`) ? after : before;
    const at = html.indexOf(`data-layer="${layer}"`);
    const ancestors = [...html.matchAll(/<[a-z][\w:-]*\b[^>]*data-layer="([^"]+)"[^>]*>/g)].filter(
      (m) =>
        m.index! <= at &&
        m.index! + (layerSnippet(html, m[1])?.length ?? 0) > at &&
        (/^<section\b/.test(m[0]) || /class="[^"]*\bdl-head\b/.test(m[0])),
    );
    const header = ancestors.find((m) => /class="[^"]*\bdl-head\b/.test(m[0]));
    const nearest = header ?? ancestors.at(-1);
    const region = nearest?.[1] ?? layer;
    const snippet = layerSnippet(html, region) ?? '';
    const title = header
      ? 'Header row'
      : words(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/.exec(snippet)?.[1] ?? '') || screen.title;
    return { layer: region, title };
  };
  const regions = new Map<
    string,
    { layer: string; title: string; added: string[]; removed: string[] }
  >();
  for (const change of changes) {
    const region = regionFor(change.layer);
    if (regions.has(region.layer)) continue;
    const old = renders?.before.words
      ? (renders.before.words[region.layer] ?? '')
      : words(layerSnippet(before, region.layer) ?? '');
    const next = renders?.after.words
      ? (renders.after.words[region.layer] ?? '')
      : words(layerSnippet(after, region.layer) ?? '');
    // Remove common word runs, retaining real visible words instead of HTML diff descriptions.
    const a = old.split(' ').filter(Boolean),
      b = next.split(' ').filter(Boolean);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (
      end < a.length - start &&
      end < b.length - start &&
      a[a.length - 1 - end] === b[b.length - 1 - end]
    )
      end++;
    const added = b.slice(start, b.length - end).join(' '),
      removed = a.slice(start, a.length - end).join(' ');
    regions.set(region.layer, {
      ...region,
      added: added ? [added] : [],
      removed: removed ? [removed] : [],
    });
  }
  let status: ReviewEvidence['status'] = screen.status;
  let nothingElse = false;
  if (renders && before && after) {
    const areas = [...regions.keys()].flatMap((layer) =>
      [renders.before.boxes[layer], renders.after.boxes[layer]].filter(Boolean),
    );
    const pixels = compareReviewPixels(renders.before.png, renders.after.png, areas);
    const boxValues = (boxes: Record<string, DesignRect>) =>
      Object.values(boxes)
        .map((r) => JSON.stringify([r.x, r.y, r.w, r.h]))
        .sort()
        .join(';');
    const boxesSame = boxValues(renders.before.boxes) === boxValues(renders.after.boxes);
    const textSame = [...regions.values()].every((r) => !r.added.length && !r.removed.length);
    if (pixels.same && boxesSame && textSame) status = 'looksSame';
    else if (!changes.length && !pixels.same) status = 'pixelsOnly';
    nothingElse = pixels.outsideSame;
  }
  return {
    ...screen,
    status,
    regions: [...regions.values()],
    nothingElse,
    seen: false,
    changeWords: Object.values(changeWords ?? {}).find(Boolean),
  };
}
