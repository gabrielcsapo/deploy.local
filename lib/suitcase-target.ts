import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  homedir,
  networkInterfaces as hostNetworkInterfaces,
  platform as hostPlatform,
} from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import packageManifest from '../package.json' with { type: 'json' };

export const SUITCASE_SCHEMA_VERSION = 1;
export const SUITCASE_RELEASE_STATE_VERSION = 1;
export const SUITCASE_RUNTIME_PROTOCOL = '1';
export const SUITCASE_PROJECT_NAME = 'deploy-local-suitcase';
export const DEFAULT_CORE_IMAGE = `ghcr.io/deploy-local/deploy.local-suitcase-core:${packageManifest.version}`;
export const DEFAULT_HELPER_IMAGE = `ghcr.io/deploy-local/deploy.local-suitcase-helper:${packageManifest.version}`;
export const DOCKER_SOCKET_WARNING =
  'Security: suitcase-core can control this Docker Engine through /var/run/docker.sock. ' +
  'Only run trusted deploy.local images and applications on this Docker host.';
export const PHYSICAL_LOSS_WARNING =
  'Physical loss: deploy.local does not encrypt powered-off Suitcase volumes or provide a locked appliance profile. ' +
  'Use host disk encryption where unattended startup permits it, and revoke a lost device from Home.';
export const SUITCASE_SECURITY_WARNING = `${DOCKER_SOCKET_WARNING} ${PHYSICAL_LOSS_WARNING}`;

export type SuitcaseAccessMode = 'auto' | 'native-local' | 'host-helper-local' | 'ip';

export interface SuitcaseTargetConfig {
  schemaVersion: 1;
  targetId: string;
  name: string;
  createdAt: string;
  runtimeProtocol: string;
  coreImage: string;
  helperImage: string;
  httpsPort: number;
  httpPort: number;
  accessMode: SuitcaseAccessMode;
}

export interface SuitcaseTargetPaths {
  directory: string;
  compose: string;
  candidateCompose: string;
  environment: string;
  identity: string;
  releaseState: string;
  slotACompose: string;
  slotBCompose: string;
}

export type SuitcaseReleaseSlotName = 'a' | 'b';

export interface SuitcaseSignatureVerification {
  status: 'verified' | 'not-configured' | 'development-override';
  method: 'cosign-key' | 'cosign-keyless' | 'none';
  detail: string;
}

export interface SuitcaseReleaseSlot {
  coreImage: string;
  helperImage: string;
  resolvedAt: string;
  signatureVerification: SuitcaseSignatureVerification;
}

export interface SuitcaseReleaseAttempt {
  attemptedAt: string;
  coreImage: string;
  helperImage: string;
  result: 'activated' | 'restored-previous';
  detail?: string;
}

export interface SuitcaseReleaseState {
  schemaVersion: 1;
  active: SuitcaseReleaseSlotName | null;
  previous: SuitcaseReleaseSlotName | null;
  slots: Partial<Record<SuitcaseReleaseSlotName, SuitcaseReleaseSlot>>;
  lastAttempt?: SuitcaseReleaseAttempt;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface SuitcaseTargetOptions {
  directory?: string;
  coreImage?: string;
  helperImage?: string;
  httpsPort?: number;
  httpPort?: number;
  accessMode?: SuitcaseAccessMode;
  platform?: NodeJS.Platform;
  networkInterfaces?: typeof hostNetworkInterfaces;
  runner?: CommandRunner;
  portAvailable?: (port: number) => Promise<boolean>;
  uuid?: () => string;
  now?: () => Date;
  allowMutableImages?: boolean;
  cosignKey?: string;
  cosignCertificateIdentity?: string;
  cosignCertificateOidcIssuer?: string;
}

export interface SuitcaseStatus {
  initialized: boolean;
  running: boolean;
  healthy: boolean;
  target?: SuitcaseTargetConfig;
  services: Array<Record<string, unknown>>;
  composePath: string;
  accessUrl?: string;
  error?: string;
  releaseState?: SuitcaseReleaseState;
}

export interface DiagnosticCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface SuitcaseDiagnostics {
  ok: boolean;
  platform: NodeJS.Platform;
  target?: SuitcaseTargetConfig;
  accessUrl?: string;
  accessMode: SuitcaseAccessMode;
  accessInstructions: string[];
  checks: DiagnosticCheck[];
}

function defaultDirectory(): string {
  return resolve(homedir(), '.deploy', 'suitcase-target');
}

export function suitcaseTargetPaths(directory = defaultDirectory()): SuitcaseTargetPaths {
  const root = resolve(directory);
  return {
    directory: root,
    compose: join(root, 'compose.yaml'),
    candidateCompose: join(root, 'compose.candidate.yaml'),
    environment: join(root, 'target.env'),
    identity: join(root, 'target.json'),
    releaseState: join(root, 'releases.json'),
    slotACompose: join(root, 'compose.slot-a.yaml'),
    slotBCompose: join(root, 'compose.slot-b.yaml'),
  };
}

function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === 'number' ? error.code : error ? 127 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
      });
    });
  });
}

function defaultPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveAvailable(false));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

function requirePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function requireImage(value: string, label: string): string {
  const image = value.trim();
  if (!image || /[\r\n\s]/.test(image)) throw new Error(`${label} is not a valid image reference`);
  return image;
}

function requireAccessMode(value: string): SuitcaseAccessMode {
  if (
    value === 'auto' ||
    value === 'native-local' ||
    value === 'host-helper-local' ||
    value === 'ip'
  ) {
    return value;
  }
  throw new Error('access mode must be auto, native-local, host-helper-local, or ip');
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function renderSuitcaseCompose(
  target: SuitcaseTargetConfig,
  targetDirectory = suitcaseTargetPaths().directory,
): string {
  return `# Generated by deploy suitcase target compose. Inspect before start; regeneration replaces this file.
name: ${SUITCASE_PROJECT_NAME}

services:
  core:
    image: ${quote(target.coreImage)}
    container_name: deploy-local-suitcase-core
    restart: unless-stopped
    environment:
      DEPLOY_ROLE: single
      DEPLOY_SUITCASE: "1"
      DEPLOY_SUITCASE_TARGET_ID: ${quote(target.targetId)}
      DEPLOY_SUITCASE_HELPER_IMAGE: ${quote(target.helperImage)}
      DEPLOY_SUITCASE_RUNTIME_PROTOCOL: ${quote(target.runtimeProtocol)}
      DEPLOY_SUITCASE_STATE_VOLUME: deploy-local-suitcase-state
      DEPLOY_SUITCASE_CONTENT_VOLUME: deploy-local-suitcase-content
      DEPLOY_SUITCASE_BUILD_CACHE_VOLUME: deploy-local-suitcase-build-cache
      DEPLOY_SUITCASE_MEMBERSHIP_FILE: /var/lib/deploy.local/fleet-membership.json
      DEPLOY_SUITCASE_MEMBERSHIP_BOOTSTRAP_FILE: /run/deploy.local/suitcase-host/fleet-membership.json
      DEPLOY_DATA_DIR: /var/lib/deploy.local
      PORT: "80"
      HTTPS_PORT: "443"
    ports:
      - ${quote(`${target.httpPort}:80`)}
      - ${quote(`${target.httpsPort}:443`)}
    volumes:
      - suitcase_state:/var/lib/deploy.local
      - suitcase_content:/var/lib/deploy.local/content
      - suitcase_build_cache:/var/lib/deploy.local/build-cache
      - ${quote(`${resolve(targetDirectory)}:/run/deploy.local/suitcase-host`)}
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - suitcase
    healthcheck:
      test: ["CMD", "/usr/local/bin/suitcase-healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 12
      start_period: 30s
    labels:
      deploy.local.target.kind: suitcase
      deploy.local.target.id: ${quote(target.targetId)}
      deploy.local.runtime.protocol: ${quote(target.runtimeProtocol)}

  volume-helper:
    image: ${quote(target.helperImage)}
    profiles: ["helpers"]
    restart: "no"
    environment:
      DEPLOY_SUITCASE_TARGET_ID: ${quote(target.targetId)}
      DEPLOY_SUITCASE_RUNTIME_PROTOCOL: ${quote(target.runtimeProtocol)}
    volumes:
      - suitcase_state:/var/lib/deploy.local
      - suitcase_content:/var/lib/deploy.local/content
    networks:
      - suitcase
    labels:
      deploy.local.target.kind: suitcase-helper
      deploy.local.target.id: ${quote(target.targetId)}

networks:
  suitcase:
    name: deploy-local-suitcase
    labels:
      deploy.local.target.id: ${quote(target.targetId)}

volumes:
  suitcase_state:
    name: deploy-local-suitcase-state
    labels:
      deploy.local.volume.role: state
      deploy.local.target.id: ${quote(target.targetId)}
  suitcase_content:
    name: deploy-local-suitcase-content
    labels:
      deploy.local.volume.role: content
      deploy.local.target.id: ${quote(target.targetId)}
  suitcase_build_cache:
    name: deploy-local-suitcase-build-cache
    labels:
      deploy.local.volume.role: build-cache
      deploy.local.target.id: ${quote(target.targetId)}
`;
}

export function renderSuitcaseEnvironment(target: SuitcaseTargetConfig): string {
  return `# Generated by deploy.local. This file contains no credentials.
SUITCASE_TARGET_ID=${target.targetId}
SUITCASE_CORE_IMAGE=${target.coreImage}
SUITCASE_HELPER_IMAGE=${target.helperImage}
SUITCASE_HTTPS_PORT=${target.httpsPort}
SUITCASE_HTTP_PORT=${target.httpPort}
SUITCASE_ACCESS_MODE=${target.accessMode}
SUITCASE_RUNTIME_PROTOCOL=${target.runtimeProtocol}
`;
}

function parseTarget(path: string): SuitcaseTargetConfig | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error(`Invalid suitcase identity at ${path}`);
  const candidate = value as Partial<SuitcaseTargetConfig>;
  if (
    candidate.schemaVersion !== SUITCASE_SCHEMA_VERSION ||
    typeof candidate.targetId !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.runtimeProtocol !== 'string' ||
    typeof candidate.coreImage !== 'string' ||
    typeof candidate.helperImage !== 'string' ||
    typeof candidate.httpsPort !== 'number' ||
    typeof candidate.httpPort !== 'number' ||
    typeof candidate.accessMode !== 'string'
  ) {
    throw new Error(`Unsupported or incomplete suitcase identity at ${path}`);
  }
  return {
    schemaVersion: SUITCASE_SCHEMA_VERSION,
    targetId: candidate.targetId,
    name: candidate.name,
    createdAt: candidate.createdAt,
    runtimeProtocol: candidate.runtimeProtocol,
    coreImage: requireImage(candidate.coreImage, 'core image'),
    helperImage: requireImage(candidate.helperImage, 'helper image'),
    httpsPort: requirePort(candidate.httpsPort, 'HTTPS port'),
    httpPort: requirePort(candidate.httpPort, 'HTTP port'),
    accessMode: requireAccessMode(candidate.accessMode),
  };
}

const immutableImagePattern = /^\S+@sha256:[a-f0-9]{64}$/i;

export function isImmutableImageReference(image: string): boolean {
  return immutableImagePattern.test(image);
}

function emptyReleaseState(): SuitcaseReleaseState {
  return {
    schemaVersion: SUITCASE_RELEASE_STATE_VERSION,
    active: null,
    previous: null,
    slots: {},
  };
}

function parseReleaseSlot(value: unknown, label: string): SuitcaseReleaseSlot {
  if (!isRecord(value)) throw new Error(`Invalid suitcase ${label} release metadata`);
  const coreImage = requireImage(String(value.coreImage ?? ''), `${label} core image`);
  const helperImage = requireImage(String(value.helperImage ?? ''), `${label} helper image`);
  if (!isImmutableImageReference(coreImage) || !isImmutableImageReference(helperImage)) {
    const verification = isRecord(value.signatureVerification)
      ? value.signatureVerification
      : undefined;
    if (verification?.status !== 'development-override') {
      throw new Error(`Suitcase ${label} release contains a mutable image reference`);
    }
  }
  const signature = value.signatureVerification;
  if (
    !isRecord(signature) ||
    !['verified', 'not-configured', 'development-override'].includes(String(signature.status)) ||
    !['cosign-key', 'cosign-keyless', 'none'].includes(String(signature.method)) ||
    typeof signature.detail !== 'string'
  ) {
    throw new Error(`Invalid suitcase ${label} signature-verification metadata`);
  }
  if (typeof value.resolvedAt !== 'string') {
    throw new Error(`Invalid suitcase ${label} resolution timestamp`);
  }
  return {
    coreImage,
    helperImage,
    resolvedAt: value.resolvedAt,
    signatureVerification: {
      status: signature.status as SuitcaseSignatureVerification['status'],
      method: signature.method as SuitcaseSignatureVerification['method'],
      detail: signature.detail,
    },
  };
}

function parseReleaseState(path: string): SuitcaseReleaseState {
  if (!existsSync(path)) return emptyReleaseState();
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || value.schemaVersion !== SUITCASE_RELEASE_STATE_VERSION) {
    throw new Error(`Unsupported suitcase release metadata at ${path}`);
  }
  const active = value.active;
  const previous = value.previous;
  if (active !== null && active !== 'a' && active !== 'b') {
    throw new Error(`Invalid active suitcase release slot at ${path}`);
  }
  if (previous !== null && previous !== 'a' && previous !== 'b') {
    throw new Error(`Invalid previous suitcase release slot at ${path}`);
  }
  if (active !== null && active === previous) {
    throw new Error(`Active and previous suitcase releases cannot share a slot at ${path}`);
  }
  const slotsValue = isRecord(value.slots) ? value.slots : {};
  const slots: SuitcaseReleaseState['slots'] = {};
  if (slotsValue.a !== undefined) slots.a = parseReleaseSlot(slotsValue.a, 'slot a');
  if (slotsValue.b !== undefined) slots.b = parseReleaseSlot(slotsValue.b, 'slot b');
  if (active && !slots[active]) throw new Error(`Active suitcase release slot is empty at ${path}`);
  if (previous && !slots[previous]) {
    throw new Error(`Previous suitcase release slot is empty at ${path}`);
  }
  let lastAttempt: SuitcaseReleaseAttempt | undefined;
  if (value.lastAttempt !== undefined) {
    if (
      !isRecord(value.lastAttempt) ||
      typeof value.lastAttempt.attemptedAt !== 'string' ||
      typeof value.lastAttempt.coreImage !== 'string' ||
      typeof value.lastAttempt.helperImage !== 'string' ||
      !['activated', 'restored-previous'].includes(String(value.lastAttempt.result)) ||
      (value.lastAttempt.detail !== undefined && typeof value.lastAttempt.detail !== 'string')
    ) {
      throw new Error(`Invalid suitcase release attempt metadata at ${path}`);
    }
    lastAttempt = value.lastAttempt as unknown as SuitcaseReleaseAttempt;
  }
  return {
    schemaVersion: SUITCASE_RELEASE_STATE_VERSION,
    active,
    previous,
    slots,
    ...(lastAttempt ? { lastAttempt } : {}),
  };
}

function parseServices(output: string): Array<Record<string, unknown>> {
  const text = output.trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    return isRecord(parsed) ? [parsed] : [];
  } catch {
    return text
      .split('\n')
      .map((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((item): item is Record<string, unknown> => item !== undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function serviceRunning(service: Record<string, unknown>): boolean {
  return String(service.State ?? service.state ?? '').toLowerCase() === 'running';
}

function serviceHealthy(service: Record<string, unknown>): boolean {
  const health = String(service.Health ?? service.health ?? '').toLowerCase();
  return serviceRunning(service) && (!health || health === 'healthy');
}

function selectLanAddress(
  networkInterfaces: ReturnType<typeof hostNetworkInterfaces>,
): string | undefined {
  const candidates = Object.entries(networkInterfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );
  const virtual = /^(docker|br-|veth|utun|tun|tap|tailscale|wg|vmnet|vbox|colima)/i;
  const physical = /^(en\d+|eth\d+|eno\d+|ens\d+|enp\w+|wlan\d+|wlp\w+|wi-?fi|ethernet)/i;
  const privateAddress = ({ address }: { address: string }) =>
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address);
  return (
    candidates.find((item) => physical.test(item.name) && privateAddress(item)) ??
    candidates.find((item) => !virtual.test(item.name) && privateAddress(item)) ??
    candidates.find((item) => !virtual.test(item.name))
  )?.address;
}

export function suitcaseAccessAdvice(
  platform: NodeJS.Platform,
  address: string | undefined,
  httpsPort: number,
  mode: SuitcaseAccessMode,
): { url: string; instructions: string[]; status: 'pass' | 'warn' } {
  const host = address ?? 'localhost';
  const url = `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  const instructions: string[] = [];
  if (mode === 'native-local') {
    instructions.push(
      'Native .local routing is selected; verify the host mDNS bridge resolves suitcase apps.',
    );
  } else if (mode === 'host-helper-local') {
    instructions.push(
      'Host-helper .local routing is selected; keep the deploy.local host helper running.',
    );
  } else {
    instructions.push(`Open ${url} to administer the suitcase from devices on the same network.`);
  }
  if (platform === 'darwin') {
    instructions.push(
      'For a router-free trip, enable macOS Internet Sharing before going offline.',
    );
    instructions.push(
      'Docker cannot create or manage the Mac Wi-Fi hotspot; .local names require a host helper.',
    );
    instructions.push(
      'Enable Docker Desktop at login so restart: unless-stopped can recover after boot.',
    );
  } else if (platform === 'win32') {
    instructions.push(
      'For a router-free trip, enable Windows Mobile hotspot before going offline.',
    );
    instructions.push(
      'Use Docker Desktop in Linux-container mode; .local names require a host helper.',
    );
    instructions.push(
      'Enable Docker Desktop at sign-in so restart: unless-stopped can recover after boot.',
    );
  } else if (platform === 'linux') {
    instructions.push(
      'For a router-free trip, configure the host Wi-Fi hotspot (for example with NetworkManager).',
    );
    instructions.push(
      'The Docker target publishes ports but does not modify the host network configuration.',
    );
    instructions.push('Enable the Docker system service at boot for automatic suitcase startup.');
  } else {
    instructions.push(
      'Create a host network or hotspot before going offline; Docker only publishes the target ports.',
    );
  }
  if (!address)
    instructions.push(
      'No LAN IPv4 address was detected; localhost is only reachable on this host.',
    );
  return { url, instructions, status: address ? 'pass' : 'warn' };
}

function composePrefix(paths: SuitcaseTargetPaths): string[] {
  return ['compose', '--project-directory', paths.directory, '-f', paths.compose];
}

function commandError(label: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return new Error(`${label}: ${detail}`);
}

function atomicWrite(path: string, contents: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { mode });
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function imageRepository(image: string): string {
  const withoutDigest = image.split('@', 1)[0] ?? image;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function repoDigests(output: string): string[] {
  const text = output.trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
    if (typeof value === 'string') return [value];
  } catch {
    // Some Docker versions/templates produce one digest per line.
  }
  return text.split(/\r?\n/).map((value) => value.trim());
}

export class SuitcaseTargetManager {
  readonly paths: SuitcaseTargetPaths;
  readonly platform: NodeJS.Platform;
  private readonly options: SuitcaseTargetOptions;
  private readonly runner: CommandRunner;
  private readonly portAvailable: (port: number) => Promise<boolean>;
  private readonly interfaces: typeof hostNetworkInterfaces;

  constructor(options: SuitcaseTargetOptions = {}) {
    this.options = options;
    this.paths = suitcaseTargetPaths(options.directory);
    this.platform = options.platform ?? hostPlatform();
    this.runner = options.runner ?? defaultRunner;
    this.portAvailable = options.portAvailable ?? defaultPortAvailable;
    this.interfaces = options.networkInterfaces ?? hostNetworkInterfaces;
  }

  readTarget(): SuitcaseTargetConfig | undefined {
    return parseTarget(this.paths.identity);
  }

  readReleaseState(): SuitcaseReleaseState {
    return parseReleaseState(this.paths.releaseState);
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private writeReleaseState(state: SuitcaseReleaseState): void {
    atomicWrite(this.paths.releaseState, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  private slotComposePath(slot: SuitcaseReleaseSlotName): string {
    return slot === 'a' ? this.paths.slotACompose : this.paths.slotBCompose;
  }

  private writeTargetArtifacts(target: SuitcaseTargetConfig, compose: string): void {
    atomicWrite(this.paths.identity, `${JSON.stringify(target, null, 2)}\n`, 0o600);
    atomicWrite(this.paths.environment, renderSuitcaseEnvironment(target), 0o600);
    atomicWrite(this.paths.compose, compose, 0o644);
  }

  ensureArtifacts(): { target: SuitcaseTargetConfig; compose: string } {
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    const existing = this.readTarget();
    const releases = this.readReleaseState();
    const activeRelease = releases.active ? releases.slots[releases.active] : undefined;
    const id = existing?.targetId ?? (this.options.uuid ?? randomUUID)();
    const target: SuitcaseTargetConfig = {
      schemaVersion: SUITCASE_SCHEMA_VERSION,
      targetId: id,
      name: existing?.name ?? `suitcase-${id.slice(0, 8)}`,
      createdAt: existing?.createdAt ?? this.now(),
      runtimeProtocol: SUITCASE_RUNTIME_PROTOCOL,
      coreImage: requireImage(
        activeRelease?.coreImage ??
          this.options.coreImage ??
          existing?.coreImage ??
          DEFAULT_CORE_IMAGE,
        'core image',
      ),
      helperImage: requireImage(
        activeRelease?.helperImage ??
          this.options.helperImage ??
          existing?.helperImage ??
          DEFAULT_HELPER_IMAGE,
        'helper image',
      ),
      httpsPort: requirePort(this.options.httpsPort ?? existing?.httpsPort ?? 8443, 'HTTPS port'),
      httpPort: requirePort(this.options.httpPort ?? existing?.httpPort ?? 8080, 'HTTP port'),
      accessMode: requireAccessMode(this.options.accessMode ?? existing?.accessMode ?? 'auto'),
    };
    if (target.httpPort === target.httpsPort)
      throw new Error('HTTP and HTTPS ports must be different');
    const compose = renderSuitcaseCompose(target, this.paths.directory);
    this.writeTargetArtifacts(target, compose);
    if (releases.active) {
      atomicWrite(this.slotComposePath(releases.active), compose, 0o644);
    }
    chmodSync(this.paths.directory, 0o700);
    return { target, compose };
  }

  compose(): { target: SuitcaseTargetConfig; path: string; contents: string } {
    const { target, compose } = this.ensureArtifacts();
    return { target, path: this.paths.compose, contents: compose };
  }

  private dockerCompose(args: string[]): Promise<CommandResult> {
    return this.runner('docker', [...composePrefix(this.paths), ...args]);
  }

  async control(action: string, args: string[] = []): Promise<unknown> {
    if (
      !/^[a-z][a-z-]*$/.test(action) ||
      args.some((value) => value.includes('\r') || value.includes('\n') || value.includes('\0'))
    ) {
      throw new Error('Invalid suitcase core control argument');
    }
    if (!this.readTarget()) throw new Error('Suitcase target is not initialized');
    const result = await this.dockerCompose([
      'exec',
      '-T',
      'core',
      'node',
      '/opt/deploy.local/dist/suitcase-control.js',
      action,
      ...args,
    ]);
    if (result.code !== 0) throw commandError('Suitcase core control failed', result);
    try {
      const responseLine = result.stdout.trim().split(/\r?\n/).at(-1) || '';
      return JSON.parse(responseLine);
    } catch {
      throw new Error('Suitcase core returned an invalid control response');
    }
  }

  private async resolveImage(
    image: string,
    label: string,
  ): Promise<{
    image: string;
    developmentOverride: boolean;
  }> {
    const pull = await this.runner('docker', ['pull', image]);
    const inspect = await this.runner('docker', [
      'image',
      'inspect',
      '--format',
      '{{json .RepoDigests}}',
      image,
    ]);
    const expectedRepository = imageRepository(image);
    const digest = repoDigests(inspect.stdout).find(
      (candidate) =>
        isImmutableImageReference(candidate) && imageRepository(candidate) === expectedRepository,
    );
    if (digest) return { image: digest, developmentOverride: false };
    if (isImmutableImageReference(image) && (pull.code === 0 || inspect.code === 0)) {
      return { image, developmentOverride: false };
    }
    if (this.options.allowMutableImages && (pull.code === 0 || inspect.code === 0)) {
      return { image, developmentOverride: true };
    }
    if (pull.code !== 0) throw commandError(`Unable to pull ${label}`, pull);
    if (inspect.code !== 0) throw commandError(`Unable to inspect ${label}`, inspect);
    throw new Error(
      `${label} ${image} did not resolve to an immutable repository digest. ` +
        'Activation was refused; --allow-mutable-images is only for local development.',
    );
  }

  private async verifyReleaseSignatures(
    images: string[],
    developmentOverride: boolean,
  ): Promise<SuitcaseSignatureVerification> {
    if (developmentOverride) {
      return {
        status: 'development-override',
        method: 'none',
        detail: 'Mutable/local image activation was explicitly allowed for development.',
      };
    }
    const key = this.options.cosignKey?.trim();
    const identity = this.options.cosignCertificateIdentity?.trim();
    const issuer = this.options.cosignCertificateOidcIssuer?.trim();
    if (key && (identity || issuer)) {
      throw new Error('Choose either a cosign key or keyless certificate identity policy');
    }
    if ((identity && !issuer) || (!identity && issuer)) {
      throw new Error(
        'Keyless cosign verification requires both certificate identity and OIDC issuer',
      );
    }
    if (!key && !identity) {
      return {
        status: 'not-configured',
        method: 'none',
        detail: 'Images are digest-pinned; no signature verification policy was configured.',
      };
    }
    const method: SuitcaseSignatureVerification['method'] = key ? 'cosign-key' : 'cosign-keyless';
    for (const image of new Set(images)) {
      const args = key
        ? ['verify', '--key', key, image]
        : [
            'verify',
            '--certificate-identity',
            identity!,
            '--certificate-oidc-issuer',
            issuer!,
            image,
          ];
      const result = await this.runner('cosign', args);
      if (result.code !== 0) throw commandError(`Cosign verification failed for ${image}`, result);
    }
    return {
      status: 'verified',
      method,
      detail:
        method === 'cosign-key'
          ? `Both images verified with cosign key ${key}.`
          : `Both images verified for ${identity} via ${issuer}.`,
    };
  }

  private async prepareRelease(
    coreImage: string,
    helperImage: string,
  ): Promise<SuitcaseReleaseSlot> {
    const core = await this.resolveImage(requireImage(coreImage, 'core image'), 'core image');
    const helper = await this.resolveImage(
      requireImage(helperImage, 'helper image'),
      'volume-helper image',
    );
    const developmentOverride = core.developmentOverride || helper.developmentOverride;
    const signatureVerification = await this.verifyReleaseSignatures(
      [core.image, helper.image],
      developmentOverride,
    );
    return {
      coreImage: core.image,
      helperImage: helper.image,
      resolvedAt: this.now(),
      signatureVerification,
    };
  }

  private targetForRelease(
    target: SuitcaseTargetConfig,
    release: SuitcaseReleaseSlot,
  ): SuitcaseTargetConfig {
    return { ...target, coreImage: release.coreImage, helperImage: release.helperImage };
  }

  private async runRelease(target: SuitcaseTargetConfig): Promise<{
    ok: boolean;
    detail?: string;
  }> {
    const compose = renderSuitcaseCompose(target, this.paths.directory);
    atomicWrite(this.paths.candidateCompose, compose, 0o644);
    atomicWrite(this.paths.compose, compose, 0o644);
    const up = await this.dockerCompose([
      'up',
      '-d',
      '--remove-orphans',
      '--force-recreate',
      '--wait',
    ]);
    if (up.code !== 0) {
      return { ok: false, detail: commandError('Candidate activation failed', up).message };
    }
    const status = await this.status();
    if (!status.healthy) {
      return {
        ok: false,
        detail: status.error ?? 'candidate did not become healthy before the Compose wait deadline',
      };
    }
    return { ok: true };
  }

  private async restoreActiveRelease(
    target: SuitcaseTargetConfig,
    state: SuitcaseReleaseState,
    candidate: SuitcaseReleaseSlot,
    detail: string,
  ): Promise<SuitcaseStatus> {
    if (!state.active) throw new Error(detail);
    const activeRelease = state.slots[state.active];
    if (!activeRelease) throw new Error(`${detail}; active rollback slot is missing`);
    const restoredTarget = this.targetForRelease(target, activeRelease);
    const restoredCompose = renderSuitcaseCompose(restoredTarget, this.paths.directory);
    this.writeTargetArtifacts(restoredTarget, restoredCompose);
    const restored = await this.dockerCompose([
      'up',
      '-d',
      '--remove-orphans',
      '--force-recreate',
      '--wait',
    ]);
    if (restored.code !== 0) {
      throw new Error(
        `${detail}; automatic restoration of slot ${state.active} failed: ${commandError('restore failed', restored).message}`,
      );
    }
    const status = await this.status();
    if (!status.healthy) {
      throw new Error(`${detail}; slot ${state.active} was restored but is not healthy`);
    }
    this.writeReleaseState({
      ...state,
      lastAttempt: {
        attemptedAt: this.now(),
        coreImage: candidate.coreImage,
        helperImage: candidate.helperImage,
        result: 'restored-previous',
        detail,
      },
    });
    return status;
  }

  private async activateRelease(
    target: SuitcaseTargetConfig,
    state: SuitcaseReleaseState,
    candidate: SuitcaseReleaseSlot,
    candidateSlot: SuitcaseReleaseSlotName,
  ): Promise<
    | { activated: true; rolledBack: false; state: SuitcaseReleaseState; status: SuitcaseStatus }
    | {
        activated: false;
        rolledBack: true;
        state: SuitcaseReleaseState;
        status: SuitcaseStatus;
        failure: string;
      }
  > {
    const candidateTarget = this.targetForRelease(target, candidate);
    const activation = await this.runRelease(candidateTarget);
    if (!activation.ok) {
      const failure = activation.detail ?? 'candidate activation failed';
      const status = await this.restoreActiveRelease(target, state, candidate, failure);
      return {
        activated: false,
        rolledBack: true,
        state: this.readReleaseState(),
        status,
        failure,
      };
    }

    const candidateCompose = renderSuitcaseCompose(candidateTarget, this.paths.directory);
    atomicWrite(this.slotComposePath(candidateSlot), candidateCompose, 0o644);
    this.writeTargetArtifacts(candidateTarget, candidateCompose);
    const activatedState: SuitcaseReleaseState = {
      schemaVersion: SUITCASE_RELEASE_STATE_VERSION,
      active: candidateSlot,
      previous: state.active,
      slots: { ...state.slots, [candidateSlot]: candidate },
      lastAttempt: {
        attemptedAt: this.now(),
        coreImage: candidate.coreImage,
        helperImage: candidate.helperImage,
        result: 'activated',
      },
    };
    this.writeReleaseState(activatedState);
    return {
      activated: true,
      rolledBack: false,
      state: activatedState,
      status: await this.status(),
    };
  }

  private async preflight(target: SuitcaseTargetConfig): Promise<{ warnings: string[] }> {
    const docker = await this.runner('docker', [
      'version',
      '--format',
      '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}',
    ]);
    if (docker.code !== 0) throw commandError('Docker Engine is unavailable', docker);
    const [version, os] = docker.stdout.trim().split('|');
    const major = Number.parseInt(version ?? '', 10);
    if (!Number.isFinite(major) || major < 24) {
      throw new Error(`Docker Engine 24 or newer is required (found ${version || 'unknown'})`);
    }
    if (os && os.toLowerCase() !== 'linux') {
      throw new Error(`Suitcase images require a Linux Docker engine (found ${os})`);
    }
    const compose = await this.runner('docker', ['compose', 'version', '--short']);
    if (compose.code !== 0) throw commandError('Docker Compose v2 is unavailable', compose);
    const composeVersion = compose.stdout.trim().replace(/^v/, '').split(/[.-]/).map(Number);
    if (
      !Number.isFinite(composeVersion[0]) ||
      composeVersion[0] < 2 ||
      (composeVersion[0] === 2 && (composeVersion[1] ?? 0) < 20)
    ) {
      throw new Error(
        `Docker Compose 2.20 or newer is required (found ${compose.stdout.trim() || 'unknown'})`,
      );
    }

    const info = await this.runner('docker', [
      'info',
      '--format',
      '{{.NCPU}}|{{.MemTotal}}|{{.DockerRootDir}}|{{.Name}}',
    ]);
    if (info.code !== 0) throw commandError('Docker host information is unavailable', info);
    const [cpuText, memoryText] = info.stdout.trim().split('|');
    const cpuCount = Number.parseInt(cpuText ?? '', 10);
    const memoryBytes = Number.parseInt(memoryText ?? '', 10);
    if (Number.isFinite(memoryBytes) && memoryBytes < 2 * 1024 ** 3) {
      throw new Error(
        'The Docker engine has less than the 2 GiB minimum memory for a suitcase target',
      );
    }
    const warnings: string[] = [];
    if (Number.isFinite(cpuCount) && cpuCount < 2)
      warnings.push('Docker has fewer than 2 CPUs available.');
    if (Number.isFinite(memoryBytes) && memoryBytes < 8 * 1024 ** 3) {
      warnings.push(
        'Docker has less than the recommended 8 GiB RAM; choose portable apps accordingly.',
      );
    }
    const existing = await this.dockerCompose(['ps', '--status', 'running', '--quiet']);
    if (!existing.stdout.trim()) {
      if (!(await this.portAvailable(target.httpsPort))) {
        throw new Error(`HTTPS port ${target.httpsPort} is already in use`);
      }
      if (!(await this.portAvailable(target.httpPort))) {
        throw new Error(`HTTP port ${target.httpPort} is already in use`);
      }
    }
    return { warnings };
  }

  async start(options: { acceptDockerSocketRisk?: boolean } = {}): Promise<{
    target: SuitcaseTargetConfig;
    status: SuitcaseStatus;
    releaseState: SuitcaseReleaseState;
    warnings: string[];
    securityWarning: string;
    accessInstructions: string[];
  }> {
    if (!options.acceptDockerSocketRisk) {
      throw new Error(`${DOCKER_SOCKET_WARNING} Re-run with --accept-docker-socket-risk.`);
    }
    const { target } = this.ensureArtifacts();
    const { warnings } = await this.preflight(target);
    let releaseState = this.readReleaseState();
    let status: SuitcaseStatus;
    if (releaseState.active) {
      const up = await this.dockerCompose(['up', '-d', '--remove-orphans', '--wait']);
      if (up.code !== 0) throw commandError('Unable to start suitcase target', up);
      status = await this.status();
      if (!status.healthy) throw new Error('Suitcase core did not become healthy');
    } else {
      const candidate = await this.prepareRelease(target.coreImage, target.helperImage);
      const activated = await this.activateRelease(target, releaseState, candidate, 'a');
      if (!activated.activated) throw new Error(activated.failure);
      status = activated.status;
      releaseState = activated.state;
    }
    const advice = suitcaseAccessAdvice(
      this.platform,
      selectLanAddress(this.interfaces()),
      target.httpsPort,
      target.accessMode,
    );
    return {
      target: status.target ?? target,
      status,
      releaseState,
      warnings,
      securityWarning: SUITCASE_SECURITY_WARNING,
      accessInstructions: advice.instructions,
    };
  }

  async stop(): Promise<{
    initialized: boolean;
    preservedVolumes: string[];
    result?: CommandResult;
  }> {
    if (!this.readTarget()) {
      return { initialized: false, preservedVolumes: [] };
    }
    const result = await this.dockerCompose(['down', '--remove-orphans']);
    if (result.code !== 0) throw commandError('Unable to stop suitcase target', result);
    return {
      initialized: true,
      preservedVolumes: [
        'deploy-local-suitcase-state',
        'deploy-local-suitcase-content',
        'deploy-local-suitcase-build-cache',
      ],
      result,
    };
  }

  async status(): Promise<SuitcaseStatus> {
    const target = this.readTarget();
    if (!target) {
      return {
        initialized: false,
        running: false,
        healthy: false,
        services: [],
        composePath: this.paths.compose,
        releaseState: this.readReleaseState(),
      };
    }
    const result = await this.dockerCompose(['ps', '--format', 'json']);
    if (result.code !== 0) {
      return {
        initialized: true,
        running: false,
        healthy: false,
        target,
        services: [],
        composePath: this.paths.compose,
        error: result.stderr.trim() || result.stdout.trim(),
        releaseState: this.readReleaseState(),
      };
    }
    const services = parseServices(result.stdout);
    const core = services.find((service) => String(service.Service ?? service.service) === 'core');
    const address = selectLanAddress(this.interfaces());
    return {
      initialized: true,
      running: !!core && serviceRunning(core),
      healthy: !!core && serviceHealthy(core),
      target,
      services,
      composePath: this.paths.compose,
      accessUrl: suitcaseAccessAdvice(this.platform, address, target.httpsPort, target.accessMode)
        .url,
      releaseState: this.readReleaseState(),
    };
  }

  async upgrade(options: { acceptDockerSocketRisk?: boolean } = {}): Promise<{
    target: SuitcaseTargetConfig;
    status: SuitcaseStatus;
    releaseState: SuitcaseReleaseState;
    activated: boolean;
    rolledBack: boolean;
    failure?: string;
    securityWarning: string;
  }> {
    if (!options.acceptDockerSocketRisk) {
      throw new Error(`${DOCKER_SOCKET_WARNING} Re-run with --accept-docker-socket-risk.`);
    }
    const { target } = this.ensureArtifacts();
    await this.preflight(target);
    const releaseState = this.readReleaseState();
    const candidate = await this.prepareRelease(
      this.options.coreImage ?? DEFAULT_CORE_IMAGE,
      this.options.helperImage ?? DEFAULT_HELPER_IMAGE,
    );
    const candidateSlot: SuitcaseReleaseSlotName = releaseState.active === 'a' ? 'b' : 'a';
    const activation = await this.activateRelease(target, releaseState, candidate, candidateSlot);
    const activeTarget = activation.status.target ?? this.readTarget() ?? target;
    return {
      target: activeTarget,
      status: activation.status,
      releaseState: activation.state,
      activated: activation.activated,
      rolledBack: activation.rolledBack,
      ...(!activation.activated ? { failure: activation.failure } : {}),
      securityWarning: SUITCASE_SECURITY_WARNING,
    };
  }

  async rollback(options: { acceptDockerSocketRisk?: boolean } = {}): Promise<{
    target: SuitcaseTargetConfig;
    status: SuitcaseStatus;
    releaseState: SuitcaseReleaseState;
    activated: boolean;
    restoredCurrent: boolean;
    failure?: string;
    securityWarning: string;
  }> {
    if (!options.acceptDockerSocketRisk) {
      throw new Error(`${DOCKER_SOCKET_WARNING} Re-run with --accept-docker-socket-risk.`);
    }
    const { target } = this.ensureArtifacts();
    await this.preflight(target);
    const releaseState = this.readReleaseState();
    if (!releaseState.active || !releaseState.previous) {
      throw new Error('No previous healthy suitcase platform release is available for rollback');
    }
    const previousRelease = releaseState.slots[releaseState.previous];
    if (!previousRelease) throw new Error('The previous suitcase release slot is empty');
    const activation = await this.activateRelease(
      target,
      releaseState,
      previousRelease,
      releaseState.previous,
    );
    const activeTarget = activation.status.target ?? this.readTarget() ?? target;
    return {
      target: activeTarget,
      status: activation.status,
      releaseState: activation.state,
      activated: activation.activated,
      restoredCurrent: activation.rolledBack,
      ...(!activation.activated ? { failure: activation.failure } : {}),
      securityWarning: SUITCASE_SECURITY_WARNING,
    };
  }

  async diagnose(): Promise<SuitcaseDiagnostics> {
    const target = this.readTarget();
    const checks: DiagnosticCheck[] = [];
    const docker = await this.runner('docker', [
      'version',
      '--format',
      '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}',
    ]);
    if (docker.code === 0) {
      const [version, os, architecture] = docker.stdout.trim().split('|');
      const dockerMajor = Number.parseInt(version ?? '', 10);
      checks.push({
        id: 'docker-engine',
        status:
          (os && os !== 'linux') || !Number.isFinite(dockerMajor) || dockerMajor < 24
            ? 'fail'
            : 'pass',
        detail: `Docker ${version || 'unknown'} (${os || 'unknown'}/${architecture || 'unknown'})`,
      });
    } else {
      checks.push({
        id: 'docker-engine',
        status: 'fail',
        detail: docker.stderr.trim() || 'Docker Engine is unreachable',
      });
    }
    const compose = await this.runner('docker', ['compose', 'version', '--short']);
    const composeVersion = compose.stdout.trim().replace(/^v/, '').split(/[.-]/).map(Number);
    const composeSupported =
      compose.code === 0 &&
      Number.isFinite(composeVersion[0]) &&
      (composeVersion[0] > 2 || (composeVersion[0] === 2 && (composeVersion[1] ?? 0) >= 20));
    checks.push({
      id: 'docker-compose',
      status: composeSupported ? 'pass' : 'fail',
      detail:
        compose.code === 0 ? `Docker Compose ${compose.stdout.trim()}` : compose.stderr.trim(),
    });
    checks.push({
      id: 'target-files',
      status: target && existsSync(this.paths.compose) ? 'pass' : 'warn',
      detail: target
        ? `Target ${target.name} at ${this.paths.directory}`
        : `Not initialized; run deploy suitcase target compose or start`,
    });
    if (target) {
      const status = await this.status();
      checks.push({
        id: 'core-container',
        status: status.healthy ? 'pass' : status.running ? 'warn' : 'fail',
        detail:
          status.error ??
          (status.healthy
            ? 'core is healthy'
            : status.running
              ? 'core is starting'
              : 'core is stopped'),
      });
    }
    checks.push({ id: 'docker-socket', status: 'warn', detail: DOCKER_SOCKET_WARNING });
    checks.push({ id: 'physical-loss', status: 'warn', detail: PHYSICAL_LOSS_WARNING });
    if (target) {
      const releases = this.readReleaseState();
      const active = releases.active ? releases.slots[releases.active] : undefined;
      checks.push({
        id: 'platform-release',
        status:
          active &&
          (isImmutableImageReference(active.coreImage) ||
            active.signatureVerification.status === 'development-override') &&
          (isImmutableImageReference(active.helperImage) ||
            active.signatureVerification.status === 'development-override')
            ? active.signatureVerification.status === 'development-override'
              ? 'warn'
              : 'pass'
            : 'fail',
        detail: active
          ? `slot ${releases.active}; ${active.signatureVerification.detail}`
          : 'No health-gated immutable platform release has been activated.',
      });
    }
    const httpsPort = target?.httpsPort ?? this.options.httpsPort ?? 8443;
    const mode = target?.accessMode ?? this.options.accessMode ?? 'auto';
    const advice = suitcaseAccessAdvice(
      this.platform,
      selectLanAddress(this.interfaces()),
      httpsPort,
      mode,
    );
    checks.push({
      id: 'offline-access',
      status: advice.status,
      detail: advice.instructions.join(' '),
    });
    return {
      ok: !checks.some((check) => check.status === 'fail'),
      platform: this.platform,
      target,
      accessUrl: advice.url,
      accessMode: mode,
      accessInstructions: advice.instructions,
      checks,
    };
  }
}
