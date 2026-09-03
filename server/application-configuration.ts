import { createHash, createHmac } from 'node:crypto';
import type { ApplicationSpec, ConfigurationType } from './application-spec.ts';
import {
  getAllApplicationConfigurationValues,
  getApplicationConfigurationValues,
  setApplicationConfigurationValue,
} from './store.ts';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey, secretAddress } from './secrets.ts';

type ConfigurationValue = string | number | boolean | null;
type ConfigurationDeclarations = ApplicationSpec['configuration'];
const MAX_CONFIGURATION_VALUE_BYTES = 64 * 1024;

export interface ResolvedApplicationConfiguration {
  values: Record<string, ConfigurationValue>;
  missing: string[];
  digest: `sha256:${string}`;
  ready: boolean;
}

function stableValue(value: ConfigurationValue): string {
  return JSON.stringify(value);
}

function assertConfigurationValue(
  key: string,
  declaration: ConfigurationDeclarations[string],
  value: unknown,
): asserts value is ConfigurationValue {
  const valid =
    ((declaration.type === 'string' ||
      declaration.type === 'secret' ||
      declaration.type === 'file' ||
      declaration.type === 'enum') &&
      typeof value === 'string') ||
    (declaration.type === 'url' && typeof value === 'string' && validAbsoluteUrl(value)) ||
    (declaration.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (declaration.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) ||
    (declaration.type === 'boolean' && typeof value === 'boolean');
  if (!valid) throw new Error(`Configuration "${key}" must be ${declaration.type}`);
  if (
    declaration.allowedValues &&
    !declaration.allowedValues.some((allowed) => Object.is(allowed, value))
  ) {
    throw new Error(`Configuration "${key}" must be one of its declared allowed values`);
  }
}

function validAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.hostname);
  } catch {
    return false;
  }
}

function valueDigest(
  value: ConfigurationValue,
  type: ConfigurationType,
  address: string,
  key: Buffer,
): string {
  const content = `${address}\0${stableValue(value)}`;
  return type === 'secret'
    ? `hmac-sha256:${createHmac('sha256', key).update(content).digest('hex')}`
    : `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Resolve one declared value into server-side storage. The declaration remains
 * in deploy.yaml; only its value is mutable here.
 */
export function setDeclaredConfigurationValue(input: {
  deploymentName: string;
  specDigest: string;
  declarations: ConfigurationDeclarations;
  key: string;
  value: unknown;
  updatedBy: string;
  siteId?: string;
}) {
  const declaration = input.declarations[input.key];
  if (!declaration) throw new Error(`Unknown declared configuration "${input.key}"`);
  assertConfigurationValue(input.key, declaration, input.value);

  const siteId = input.siteId || '';
  if (declaration.scope === 'site' && !siteId) {
    throw new Error(`Configuration "${input.key}" requires a site`);
  }
  if (declaration.scope === 'application' && siteId) {
    throw new Error(`Configuration "${input.key}" is application-scoped`);
  }

  const secretKey = loadOrCreateSecretKey();
  const address = secretAddress(input.deploymentName, input.key, siteId, input.specDigest);
  const serialized = stableValue(input.value);
  if (Buffer.byteLength(serialized) > MAX_CONFIGURATION_VALUE_BYTES) {
    throw new Error(`Configuration "${input.key}" exceeds the 64 KiB value limit`);
  }
  const storedValue =
    declaration.type === 'secret'
      ? encryptSecret(input.value as string, secretKey, address)
      : serialized;
  return setApplicationConfigurationValue({
    deploymentName: input.deploymentName,
    specDigest: input.specDigest,
    key: input.key,
    siteId,
    valueType: declaration.type,
    value: storedValue,
    valueDigest: valueDigest(input.value, declaration.type, address, secretKey),
    updatedBy: input.updatedBy,
  });
}

export function resolveApplicationConfiguration(input: {
  deploymentName: string;
  specDigest: string;
  declarations: ConfigurationDeclarations;
  siteId?: string;
}): ResolvedApplicationConfiguration {
  const siteId = input.siteId || '';
  const applicationRows = new Map(
    getApplicationConfigurationValues(input.deploymentName, input.specDigest).map((row) => [
      row.key,
      row,
    ]),
  );
  const siteRows = siteId
    ? new Map(
        getApplicationConfigurationValues(input.deploymentName, input.specDigest, siteId).map(
          (row) => [row.key, row],
        ),
      )
    : new Map<string, ReturnType<typeof getApplicationConfigurationValues>[number]>();
  const secretKey = loadOrCreateSecretKey();
  const values: Record<string, ConfigurationValue> = {};
  const missing: string[] = [];
  const digestEntries: Array<[string, string]> = [];

  for (const key of Object.keys(input.declarations).sort()) {
    const declaration = input.declarations[key];
    const row = declaration.scope === 'site' ? siteRows.get(key) : applicationRows.get(key);
    if (row) {
      if (row.valueType !== declaration.type) {
        throw new Error(`Stored configuration "${key}" does not match its declaration`);
      }
      const address = secretAddress(input.deploymentName, key, row.siteId, input.specDigest);
      const value =
        declaration.type === 'secret'
          ? decryptSecret(row.value, secretKey, address)
          : (JSON.parse(row.value) as unknown);
      assertConfigurationValue(key, declaration, value);
      values[key] = value;
      digestEntries.push([key, row.valueDigest]);
      continue;
    }
    if (declaration.default !== undefined) {
      values[key] = declaration.default;
      const address = secretAddress(
        input.deploymentName,
        key,
        declaration.scope === 'site' ? siteId : '',
        input.specDigest,
      );
      digestEntries.push([
        key,
        valueDigest(declaration.default, declaration.type, address, secretKey),
      ]);
    } else if (declaration.required) {
      missing.push(key);
      digestEntries.push([key, 'missing']);
    }
  }

  const digest = `sha256:${createHash('sha256')
    .update(JSON.stringify(digestEntries))
    .digest('hex')}` as const;
  return { values, missing, digest, ready: missing.length === 0 };
}

/** Carry values to a new release only when their validation contract remains compatible. */
export function carryForwardCompatibleConfiguration(input: {
  deploymentName: string;
  fromSpec: ApplicationSpec;
  fromDigest: string;
  toSpec: ApplicationSpec;
  toDigest: string;
  updatedBy: string;
}) {
  if (input.fromDigest === input.toDigest) return 0;
  const sourceRows = getAllApplicationConfigurationValues(input.deploymentName, input.fromDigest);
  const secretKey = loadOrCreateSecretKey();
  let carried = 0;

  for (const row of sourceRows) {
    const before = input.fromSpec.configuration[row.key];
    const after = input.toSpec.configuration[row.key];
    const compatible =
      before &&
      after &&
      before.type === after.type &&
      before.scope === after.scope &&
      JSON.stringify(before.allowedValues ?? null) === JSON.stringify(after.allowedValues ?? null);
    if (!compatible) continue;

    const sourceAddress = secretAddress(
      input.deploymentName,
      row.key,
      row.siteId,
      input.fromDigest,
    );
    const value =
      before.type === 'secret'
        ? decryptSecret(row.value, secretKey, sourceAddress)
        : (JSON.parse(row.value) as ConfigurationValue);
    setDeclaredConfigurationValue({
      deploymentName: input.deploymentName,
      specDigest: input.toDigest,
      declarations: input.toSpec.configuration,
      key: row.key,
      value,
      siteId: after.scope === 'site' ? row.siteId : undefined,
      updatedBy: input.updatedBy,
    });
    carried++;
  }

  return carried;
}

export function resolveComponentEnvironment(input: {
  spec: ApplicationSpec;
  component: string;
  configuration: Record<string, ConfigurationValue>;
  bindings?: Record<string, string>;
}) {
  const component = input.spec.components[input.component];
  if (!component) throw new Error(`Unknown component "${input.component}"`);
  const environment: Record<string, string> = {};
  const unresolvedBindings: string[] = [];
  for (const [variable, reference] of Object.entries(component.environment)) {
    const [owner, member] = reference.from.split('.');
    if (owner === 'configuration') {
      if (!Object.hasOwn(input.configuration, member)) {
        const declaration = input.spec.configuration[member];
        if (declaration && !declaration.required) continue;
        throw new Error(`Configuration "${member}" is not resolved`);
      }
      environment[variable] = String(input.configuration[member]);
    } else {
      const value = input.bindings?.[reference.from];
      if (value === undefined) unresolvedBindings.push(reference.from);
      else environment[variable] = value;
    }
  }
  return { environment, unresolvedBindings };
}
