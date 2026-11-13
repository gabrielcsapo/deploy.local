import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { deployDataDirectory, deployDataPath } from '../kernel/files/data-directory.ts';
import { sshFingerprint } from './ssh-keys.ts';

export function configuredSshPort() {
  const port = Number(process.env.DEPLOY_SSH_PORT || 2222);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('DEPLOY_SSH_PORT must be between 0 and 65535');
  return port;
}
export function sshHostKey() {
  const path = deployDataPath('ssh_host_ed25519_key');
  mkdirSync(deployDataDirectory(), { recursive: true });
  try {
    if (!existsSync(path))
      writeFileSync(path, utils.generateKeyPairSync('ed25519').private, {
        flag: 'wx',
        mode: 0o600,
      });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  const privateKey = readFileSync(path);
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey() || key.type !== 'ssh-ed25519') throw new Error('Invalid SSH host key');
  return {
    privateKey,
    publicKey: `${key.type} ${key.getPublicSSH().toString('base64')}`,
    fingerprint: sshFingerprint(key.getPublicSSH()),
  };
}
let activePort: number | null = null;
let activeHost: ReturnType<typeof sshHostKey> | null = null;
export function setSshServerState(
  port: number | null,
  host: ReturnType<typeof sshHostKey> | null = null,
) {
  activePort = port;
  activeHost = host;
}
export function sshServerInfo() {
  return {
    enabled: activePort !== null,
    port: activePort,
    hostFingerprints: activeHost ? [activeHost.fingerprint] : [],
    knownHostsLine:
      activeHost && activePort !== null
        ? `[deploy.local]:${activePort} ${activeHost.publicKey}`
        : '',
  };
}
