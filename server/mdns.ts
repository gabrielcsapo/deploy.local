// NOTE: keep this module dependency-light (no store.ts import) — the edge
// process loads it, and store.ts runs DB migrations on open, which only the
// control plane may do.
import { networkInterfaces } from 'node:os';
import multicastDns from '@deploy.local/mdns';

// ── Local IP detection ──────────────────────────────────────────────────────

export function getLocalIPv4(): string {
  const configured = process.env.DEPLOY_MDNS_ADDRESS?.trim();
  if (configured) return configured;
  const interfaces = networkInterfaces();
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((iface) => iface.family === 'IPv4' && !iface.internal)
      .map((iface) => ({ name, address: iface.address })),
  );
  const virtual = /^(docker|br-|veth|utun|tun|tap|tailscale|wg|vmnet|vbox|colima)/i;
  const physical = /^(en\d+|eth\d+|eno\d+|ens\d+|enp\w+|wlan\d+|wlp\w+|bond\d+|br0)$/i;
  const preferred = candidates.find(
    (candidate) => physical.test(candidate.name) && !virtual.test(candidate.name),
  );
  if (preferred) return preferred.address;
  const nonVirtual = candidates.find((candidate) => !virtual.test(candidate.name));
  if (nonVirtual) return nonVirtual.address;
  if (candidates[0]) {
    return candidates[0].address;
  }
  return '127.0.0.1';
}

// ── mDNS hostname registry ──────────────────────────────────────────────────

const registeredHosts = new Set<string>();
let mdns: ReturnType<typeof multicastDns> | null = null;
let announcementTimer: ReturnType<typeof setInterval> | null = null;

function ensureMdns() {
  if (mdns) return mdns;
  mdns = multicastDns();
  mdns.on('warning', (err) => console.warn(`mDNS warning: ${err.message}`));
  mdns.on('error', (err) => console.error(`mDNS error: ${err.message}`));
  announcementTimer = setInterval(() => {
    const ip = getLocalIPv4();
    for (const hostname of registeredHosts) announceHost(mdns!, hostname, ip);
  }, 60_000);
  announcementTimer.unref();
  return mdns;
}

function announceHost(m: ReturnType<typeof multicastDns>, hostname: string, ip: string) {
  m.registerResponse(hostname, ip, 120);
  m.respond({
    answers: [{ name: hostname, type: 'A', data: ip, ttl: 120 }],
  });
}

export function registerHost(name: string) {
  const hostname = `${name.toLowerCase()}.local`;
  const newlyRegistered = !registeredHosts.has(hostname);
  registeredHosts.add(hostname);
  const m = ensureMdns();
  const ip = getLocalIPv4();

  // Re-register and announce on every route reconciliation. This refreshes
  // clients that cached an earlier NXDOMAIN and also picks up address changes.
  announceHost(m, hostname, ip);
  console.log(`mDNS: ${newlyRegistered ? 'registered' : 'announced'} ${hostname} → ${ip}`);
}

export function unregisterHost(name: string) {
  const hostname = `${name.toLowerCase()}.local`;
  registeredHosts.delete(hostname);
  if (mdns) mdns.unregisterResponse(hostname);
  console.log(`mDNS: unregistered ${hostname}`);
}

export function registerAllDeployments(names: string[]) {
  for (const name of names) {
    registerHost(name);
  }
}
