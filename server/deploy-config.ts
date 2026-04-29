import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PortMapping {
  container: number;
  protocol?: string;
}

export interface VolumeMountConfig {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface DeployConfig {
  port?: number;
  ports?: PortMapping[];
  discoverable?: boolean;
  gpus?: boolean;
  volumes?: VolumeMountConfig[];
  privilegedDocker?: boolean;
  ignore?: string[];
}

const ALLOWED_KEYS = new Set([
  '$schema',
  'port',
  'ports',
  'discoverable',
  'gpus',
  'volumes',
  'privilegedDocker',
  'ignore',
]);
const ALLOWED_PORT_KEYS = new Set(['container', 'protocol']);
const ALLOWED_VOLUME_KEYS = new Set(['hostPath', 'containerPath', 'readOnly']);
const VALID_PROTOCOLS = new Set(['tcp', 'udp']);

export function readDeployConfig(dir: string): DeployConfig {
  const configPath = resolve(dir, 'deploy.json');
  if (!existsSync(configPath)) return {};

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('deploy.json must be a JSON object');
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`deploy.json: unknown field "${key}"`);
    }
  }

  const config: DeployConfig = {};

  if (raw.port !== undefined) {
    if (
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      raw.port < 1 ||
      raw.port > 65535
    ) {
      throw new Error('deploy.json: "port" must be an integer between 1 and 65535');
    }
    config.port = raw.port;
  }

  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) {
      throw new Error('deploy.json: "ports" must be an array');
    }
    config.ports = raw.ports.map((entry: unknown, i: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`deploy.json: ports[${i}] must be an object`);
      }
      const obj = entry as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!ALLOWED_PORT_KEYS.has(key)) {
          throw new Error(`deploy.json: ports[${i}] has unknown field "${key}"`);
        }
      }
      if (
        typeof obj.container !== 'number' ||
        !Number.isInteger(obj.container) ||
        obj.container < 1 ||
        obj.container > 65535
      ) {
        throw new Error(
          `deploy.json: ports[${i}].container must be an integer between 1 and 65535`,
        );
      }
      if (
        obj.protocol !== undefined &&
        (typeof obj.protocol !== 'string' || !VALID_PROTOCOLS.has(obj.protocol))
      ) {
        throw new Error(`deploy.json: ports[${i}].protocol must be "tcp" or "udp"`);
      }
      return {
        container: obj.container,
        protocol: (obj.protocol as string) || undefined,
      };
    });
  }

  if (raw.discoverable !== undefined) {
    if (typeof raw.discoverable !== 'boolean') {
      throw new Error('deploy.json: "discoverable" must be a boolean');
    }
    config.discoverable = raw.discoverable;
  }

  if (raw.gpus !== undefined) {
    if (typeof raw.gpus !== 'boolean') {
      throw new Error('deploy.json: "gpus" must be a boolean');
    }
    config.gpus = raw.gpus;
  }

  if (raw.volumes !== undefined) {
    if (!Array.isArray(raw.volumes)) {
      throw new Error('deploy.json: "volumes" must be an array');
    }
    config.volumes = raw.volumes.map((entry: unknown, i: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`deploy.json: volumes[${i}] must be an object`);
      }
      const obj = entry as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!ALLOWED_VOLUME_KEYS.has(key)) {
          throw new Error(`deploy.json: volumes[${i}] has unknown field "${key}"`);
        }
      }
      if (typeof obj.hostPath !== 'string' || obj.hostPath.length === 0) {
        throw new Error(`deploy.json: volumes[${i}].hostPath must be a non-empty string`);
      }
      if (typeof obj.containerPath !== 'string' || obj.containerPath.length === 0) {
        throw new Error(`deploy.json: volumes[${i}].containerPath must be a non-empty string`);
      }
      if (obj.readOnly !== undefined && typeof obj.readOnly !== 'boolean') {
        throw new Error(`deploy.json: volumes[${i}].readOnly must be a boolean`);
      }
      return {
        hostPath: obj.hostPath,
        containerPath: obj.containerPath,
        readOnly: (obj.readOnly as boolean) || undefined,
      };
    });
  }

  if (raw.privilegedDocker !== undefined) {
    if (typeof raw.privilegedDocker !== 'boolean') {
      throw new Error('deploy.json: "privilegedDocker" must be a boolean');
    }
    config.privilegedDocker = raw.privilegedDocker;
  }

  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) {
      throw new Error('deploy.json: "ignore" must be an array of strings');
    }
    for (let i = 0; i < raw.ignore.length; i++) {
      if (typeof raw.ignore[i] !== 'string' || raw.ignore[i].length === 0) {
        throw new Error(`deploy.json: ignore[${i}] must be a non-empty string`);
      }
    }
    config.ignore = raw.ignore;
  }

  return config;
}
