import { bufferedExporter } from './http.js';

// Both sides of an Electron bridge use the same W3C context. The caller owns
// the authenticated exporter and supplies fixed operation names, never IPC arguments.
export function electronProfile({ service, process, send }) {
  if (!['main', 'renderer'].includes(process)) throw new Error('Unknown Electron process');
  const record = bufferedExporter((spans) =>
    send({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: service } },
              { key: 'electron.process.type', value: { stringValue: process } },
            ],
          },
          scopeSpans: [{ scope: { name: 'electron.ipc' }, spans }],
        },
      ],
    }),
  );
  return async function measure(name, parent, work) {
    const parsed =
      typeof parent === 'string' && /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(parent);
    const valid = parsed && !/^0+$/.test(parsed[1]) && !/^0+$/.test(parsed[2]);
    if (valid && !(parseInt(parsed[3], 16) & 1)) return work(parent);
    const id = () => crypto.randomUUID().replaceAll('-', '');
    const traceId = valid ? parsed[1] : id();
    const spanId = id().slice(0, 16);
    const at = () =>
      String(BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n);
    const span = {
      traceId,
      spanId,
      ...(valid ? { parentSpanId: parsed[2] } : {}),
      name,
      kind: 1,
      startTimeUnixNano: at(),
      status: { code: 0 },
    };
    try {
      return await work(`00-${traceId}-${spanId}-01`);
    } catch (error) {
      span.status.code = 2;
      throw error;
    } finally {
      const end = at();
      record({
        ...span,
        endTimeUnixNano: end,
        events: [{ name: span.status.code === 2 ? 'ipc.failed' : 'ipc.reply', timeUnixNano: end }],
      });
    }
  };
}
