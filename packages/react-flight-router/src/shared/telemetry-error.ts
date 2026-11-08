/** Same normalized frames and SHA-1 input on the server and in the browser. */
export function normalizeError(error: unknown, relativePath: (path: string) => string) {
  const value =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
  const name = value.name || 'Error';
  const message = value.message.slice(0, 500);
  const frames = (value.stack ?? '')
    .split('\n')
    .slice(1)
    .map((frame) =>
      frame.replace(
        /(?<![\w:])(?:file:\/\/|https?:\/\/[^/\s)]+)?((?:[A-Za-z]:)?\/[^\s)]+)(?=\)?)/g,
        (_whole, path: string) => {
          const location = path.match(/(:\d+(?::\d+)?)$/)?.[0] ?? '';
          const file = path.slice(0, path.length - location.length).split(/[?#]/)[0];
          return relativePath(file) + location;
        },
      ),
    );
  return {
    fields: { name, message, stack: `${name}: ${message}\n${frames.join('\n')}`.slice(0, 4000) },
    fingerprintInput:
      name +
      frames
        .slice(0, 5)
        .map((frame) => frame.trim().replace(/:\d+(?::\d+)?/g, ':#'))
        .join('\n'),
  };
}
