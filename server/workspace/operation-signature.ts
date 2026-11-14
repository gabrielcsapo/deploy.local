import { createHash } from 'node:crypto';

// Logical command names are durable: moving the public resource must not invalidate a
// previously issued operationId. The old project-create command hashed /projects + body.
export function operationSignature(path: string, body: unknown): string {
  const logical = path === '/repository-projects' ? '/projects' : path;
  const stable = (value: any): any =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : Array.isArray(value)
        ? value.map(stable)
        : value;
  return createHash('sha256')
    .update(logical + JSON.stringify(stable(body)))
    .digest('hex');
}
