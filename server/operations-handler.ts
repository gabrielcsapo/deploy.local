import { resolve } from 'node:path';
import {
  createRecoveryBundle,
  rehearseRecoveryBundle,
  restoreRecoveryBundle,
  verifyRecoveryBundle,
} from './recovery-bundle.ts';
import { evaluateV1ReleaseReadiness } from './release-readiness.ts';
import { getSqlite } from './store.ts';
import { createSupportBundle } from './support-bundle.ts';

export interface OperationsHandlerRequest {
  method: 'GET' | 'POST';
  pathname: string;
  body?: unknown;
  actor: { username: string; role: 'admin' | 'user' };
}

export interface OperationsHandlerResponse {
  status: number;
  body: unknown;
}

export async function handleOperationsRequest(
  request: OperationsHandlerRequest,
): Promise<OperationsHandlerResponse> {
  if (request.actor.role !== 'admin') {
    return {
      status: 403,
      body: { error: 'Recovery and support operations require an administrator' },
    };
  }
  try {
    const url = new URL(request.pathname, 'http://operations.local');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== 'operations') return notFound();

    if (request.method === 'GET' && segments[1] === 'release-readiness' && segments.length === 2) {
      return { status: 200, body: evaluateV1ReleaseReadiness() };
    }

    if (request.method === 'GET' && segments[1] === 'recovery-bundles' && segments.length === 2) {
      return {
        status: 200,
        body: {
          bundles: getSqlite()!
            .prepare(
              `SELECT id, fleet_id, format_version, artifact_digest, inventory_digest,
                      verification_status, created_at, verified_at, rehearsal_status, rehearsed_at
                 FROM fleet_recovery_bundles ORDER BY created_at DESC`,
            )
            .all(),
        },
      };
    }

    if (request.method === 'POST' && segments[1] === 'recovery-bundles' && segments.length === 2) {
      const body = record(request.body);
      const outputPath = requiredString(body.outputPath, 'outputPath');
      const passphrase = requiredString(body.passphrase, 'passphrase');
      return {
        status: 201,
        body: {
          ...(await createRecoveryBundle({ outputPath, passphrase })),
          outputPath: resolve(outputPath),
        },
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'recovery-bundles' &&
      segments[2] === 'verify' &&
      segments.length === 3
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: verifyRecoveryBundle({
          bundlePath: requiredString(body.bundlePath, 'bundlePath'),
          passphrase: requiredString(body.passphrase, 'passphrase'),
          bundleId: optionalString(body.bundleId),
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'recovery-bundles' &&
      segments[2] === 'restore' &&
      segments.length === 3
    ) {
      const body = record(request.body);
      return {
        status: 201,
        body: restoreRecoveryBundle({
          bundlePath: requiredString(body.bundlePath, 'bundlePath'),
          passphrase: requiredString(body.passphrase, 'passphrase'),
          destinationDataDirectory: requiredString(
            body.destinationDataDirectory,
            'destinationDataDirectory',
          ),
        }),
      };
    }

    if (
      request.method === 'POST' &&
      segments[1] === 'recovery-bundles' &&
      segments[2] &&
      segments[3] === 'rehearsal' &&
      segments.length === 4
    ) {
      const body = record(request.body);
      return {
        status: 200,
        body: rehearseRecoveryBundle({
          bundleId: segments[2],
          bundlePath: requiredString(body.bundlePath, 'bundlePath'),
          passphrase: requiredString(body.passphrase, 'passphrase'),
        }),
      };
    }

    if (request.method === 'POST' && segments[1] === 'support-bundles' && segments.length === 2) {
      const body = record(request.body);
      return {
        status: 201,
        body: await createSupportBundle({
          outputPath: requiredString(body.outputPath, 'outputPath'),
          createdBy: request.actor.username,
        }),
      };
    }

    return notFound();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: /not found/i.test(message) ? 404 : 400, body: { error: message } };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function notFound(): OperationsHandlerResponse {
  return { status: 404, body: { error: 'Operations route not found' } };
}
