// `deploy design export`: the boards as one PDF, a page for each, in canvas order, at the board's
// own size. Chromium prints each board to a PDF of its own (a document runs over as many pages as
// it needs); this joins them, since a PDF's pages can differ in size but a browser prints one
// size at a time. Chromium's PDFs have plain objects and a classic cross-reference table, which
// is all the joining reads.

/** The boards to export, in canvas order: canvas.json's "order", then the rest as the canvas lists them. */
export function exportOrder(canvas, files) {
  const present = new Set(files);
  const ordered = [];
  const take = (file) => {
    if (present.has(file) && !ordered.includes(file)) ordered.push(file);
  };
  for (const file of Array.isArray(canvas?.order) ? canvas.order : []) take(file);
  for (const file of Object.keys(canvas?.boards ?? {})) take(file);
  for (const file of [...files].sort()) take(file);
  return ordered;
}

/** The objects of a PDF written by Chromium: { id, dict, stream } with `stream` the bytes after the dictionary, or null. */
function readObjects(text) {
  const objects = [];
  const header = /(?:^|\n)(\d+) 0 obj\n/g;
  let match;
  while ((match = header.exec(text))) {
    const start = match.index + match[0].length;
    let end = text.indexOf('endobj', start);
    const streamAt = text.indexOf('\nstream\n', start);
    if (streamAt !== -1 && streamAt < end) {
      const streamEnd = text.indexOf('\nendstream', streamAt + 8);
      end = text.indexOf('endobj', streamEnd);
      objects.push({
        id: Number(match[1]),
        dict: text.slice(start, streamAt),
        stream: text.slice(streamAt, end),
      });
    } else objects.push({ id: Number(match[1]), dict: text.slice(start, end), stream: null });
    header.lastIndex = end;
  }
  return objects;
}

/** One PDF from several: every page of each, in order. Returns { pdf, pages }. */
export function mergePdfs(pdfs) {
  const kept = [];
  const pageIds = [];
  let next = 3;
  const pagesId = 2;
  for (const pdf of pdfs) {
    const objects = readObjects(pdf.toString('latin1'));
    const offset = next - 1;
    for (const object of objects) {
      // The catalog, the page tree and the tag tree are rebuilt or dropped; pages and what they
      // draw with are kept.
      if (/\/Type\s*\/(Catalog|Pages|StructTreeRoot|StructElem|ParentTree)\b/.test(object.dict))
        continue;
      if (/^<<\s*\/Creator/.test(object.dict)) continue;
      const id = object.id + offset;
      let dict = object.dict.replace(/(\d+) 0 R/g, (_, n) => `${Number(n) + offset} 0 R`);
      if (/\/Type\s*\/Page\b(?!s)/.test(dict)) {
        dict = dict.replace(/\/Parent\s+\d+ 0 R/, `/Parent ${pagesId} 0 R`);
        pageIds.push(id);
      }
      kept.push({ id, body: dict + (object.stream ?? '') });
    }
    next += Math.max(0, ...objects.map((object) => object.id)) + 1;
  }
  const catalogId = next;
  kept.push(
    {
      id: pagesId,
      body: `<</Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length}>>`,
    },
    { id: catalogId, body: `<</Type /Catalog /Pages ${pagesId} 0 R>>` },
  );
  kept.sort((a, b) => a.id - b.id);
  let out = '%PDF-1.4\n';
  const offsets = new Map();
  for (const object of kept) {
    offsets.set(object.id, out.length);
    out += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${catalogId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= catalogId; id++)
    out += offsets.has(id)
      ? `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  out += `trailer\n<</Size ${catalogId + 1} /Root ${catalogId} 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return { pdf: Buffer.from(out, 'latin1'), pages: pageIds.length };
}
