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
  cache?: {
    enabled: boolean;
    maxAge: number;
    paths: string[];
    maxObjectBytes: number;
  };
  docker?: {
    runArgs: string[];
    networks: Array<{
      name: string;
      driver?: string;
      subnet?: string;
      labels: Record<string, string>;
    }>;
  };
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
  'cache',
  'docker',
]);
const ALLOWED_PORT_KEYS = new Set(['container', 'protocol']);
const ALLOWED_VOLUME_KEYS = new Set(['hostPath', 'containerPath', 'readOnly']);
const VALID_PROTOCOLS = new Set(['tcp', 'udp']);
const ALLOWED_CACHE_KEYS = new Set([
  'enabled',
  'maxAge',
  'paths',
  'maxObjectBytes',
]);
const ALLOWED_DOCKER_KEYS = new Set(['runArgs', 'networks']);
const ALLOWED_NETWORK_KEYS = new Set(['name', 'driver', 'subnet', 'labels']);
const RESERVED_RUN_ARGS = new Set(['--name', '--rm', '-d', '--detach']);

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

  if (raw.cache !== undefined) {
    if (typeof raw.cache !== 'object' || raw.cache === null || Array.isArray(raw.cache)) {
      throw new Error('deploy.json: "cache" must be an object');
    }
    for (const key of Object.keys(raw.cache)) {
      if (!ALLOWED_CACHE_KEYS.has(key)) throw new Error(`deploy.json: cache has unknown field "${key}"`);
    }
    const cache = raw.cache as Record<string, unknown>;
    if (cache.enabled !== undefined && typeof cache.enabled !== 'boolean') {
      throw new Error('deploy.json: cache.enabled must be a boolean');
    }
    const maxAge = cache.maxAge ?? 60;
    if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 86400) {
      throw new Error('deploy.json: cache.maxAge must be an integer between 1 and 86400');
    }
    const paths = cache.paths ?? [];
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
      throw new Error('deploy.json: cache.paths must be an array of absolute path patterns');
    }
    const maxObjectBytes = cache.maxObjectBytes ?? 2 * 1024 * 1024;
    if (typeof maxObjectBytes !== 'number' || !Number.isInteger(maxObjectBytes) || maxObjectBytes < 1024 || maxObjectBytes > 16 * 1024 * 1024) {
      throw new Error('deploy.json: cache.maxObjectBytes must be between 1024 and 16777216');
    }
    config.cache = {
      enabled: cache.enabled !== false,
      maxAge,
      paths: paths as string[],
      maxObjectBytes,
    };
  }

  if (raw.docker !== undefined) {
    if (typeof raw.docker !== 'object' || raw.docker === null || Array.isArray(raw.docker)) {
      throw new Error('deploy.json: "docker" must be an object');
    }
    for (const key of Object.keys(raw.docker)) {
      if (!ALLOWED_DOCKER_KEYS.has(key)) throw new Error(`deploy.json: docker has unknown field "${key}"`);
    }
    const docker = raw.docker as Record<string, unknown>;
    const runArgs = docker.runArgs ?? [];
    if (!Array.isArray(runArgs) || runArgs.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
      throw new Error('deploy.json: docker.runArgs must be an array of non-empty strings');
    }
    for (const arg of runArgs as string[]) {
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (RESERVED_RUN_ARGS.has(flag)) {
        throw new Error(`deploy.json: docker.runArgs cannot override reserved argument "${flag}"`);
      }
    }
    const networks = docker.networks ?? [];
    if (!Array.isArray(networks)) throw new Error('deploy.json: docker.networks must be an array');
    const parsedNetworks = networks.map((entry: unknown, index: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`deploy.json: docker.networks[${index}] must be an object`);
      }
      const network = entry as Record<string, unknown>;
      for (const key of Object.keys(network)) {
        if (!ALLOWED_NETWORK_KEYS.has(key)) throw new Error(`deploy.json: docker.networks[${index}] has unknown field "${key}"`);
      }
      if (typeof network.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network.name)) {
        throw new Error(`deploy.json: docker.networks[${index}].name is invalid`);
      }
      if (network.driver !== undefined && (typeof network.driver !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(network.driver))) {
        throw new Error(`deploy.json: docker.networks[${index}].driver is invalid`);
      }
      if (network.subnet !== undefined && (typeof network.subnet !== 'string' || !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(network.subnet))) {
        throw new Error(`deploy.json: docker.networks[${index}].subnet must be CIDR notation`);
      }
      const labels = network.labels ?? {};
      if (typeof labels !== 'object' || labels === null || Array.isArray(labels) || Object.entries(labels).some(([key, value]) => !key || typeof value !== 'string')) {
        throw new Error(`deploy.json: docker.networks[${index}].labels must be a string map`);
      }
      return {
        name: network.name,
        driver: network.driver as string | undefined,
        subnet: network.subnet as string | undefined,
        labels: labels as Record<string, string>,
      };
    });
    config.docker = { runArgs: runArgs as string[], networks: parsedNetworks };
  }

  return config;
}
