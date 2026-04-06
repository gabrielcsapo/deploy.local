import { networkInterfaces } from 'node:os';
import multicastDns from '@deploy.local/mdns';
import { getAllDeployments } from './store.ts';

// ── Local IP detection ──────────────────────────────────────────────────────

export function getLocalIPv4(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ── mDNS hostname registry ──────────────────────────────────────────────────

const registeredHosts = new Set<string>();
let mdns: ReturnType<typeof multicastDns> | null = null;

function ensureMdns() {
  if (mdns) return mdns;
  mdns = multicastDns();
  return mdns;
}

export function registerHost(name: string) {
  const hostname = `${name.toLowerCase()}.local`;
  if (registeredHosts.has(hostname)) return;

  registeredHosts.add(hostname);
  const m = ensureMdns();
  const ip = getLocalIPv4();

  // Pre-encode the response buffer for instant cache replies
  m.registerResponse(hostname, ip, 120);

  // Proactive announcement so clients discover it immediately
  m.respond({
    answers: [{ name: hostname, type: 'A', data: ip, ttl: 120 }],
  });

  console.log(`mDNS: registered ${hostname} → ${ip}`);
}

export function unregisterHost(name: string) {
  const hostname = `${name.toLowerCase()}.local`;
  registeredHosts.delete(hostname);
  if (mdns) mdns.unregisterResponse(hostname);
  console.log(`mDNS: unregistered ${hostname}`);
}

export function registerAllDeployments() {
  const deployments = getAllDeployments();
  for (const d of deployments) {
    registerHost(d.name);
  }
}
