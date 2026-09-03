import { createHash } from 'node:crypto';

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | CanonicalObject;
interface CanonicalObject {
  [key: string]: CanonicalValue;
}

export function canonicalCatalogJson(value: unknown): string {
  return JSON.stringify(normalize(value, '$'));
}

export function catalogContentDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalCatalogJson(value)).digest('hex')}`;
}

function normalize(value: unknown, path: string): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== 'object') throw new Error(`${path} contains unsupported ${typeof value}`);

  const output: CanonicalObject = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined) throw new Error(`${path}.${key} must not be undefined`);
    output[key] = normalize(member, `${path}.${key}`);
  }
  return output;
}
