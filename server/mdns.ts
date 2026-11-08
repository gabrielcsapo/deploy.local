// NOTE: keep this module dependency-light (no store.ts import) — the edge
// process loads it, and store.ts runs DB migrations on open, which only the
// control plane may do.
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import multicastDns from '@deploy.local/mdns';
import { buildARecordResponse } from '../packages/mdns/dns.ts';

// ── Local IP detection ──────────────────────────────────────────────────────

/**
 * Interfaces carrying a default route, best (lowest metric) first. Linux only; elsewhere empty.
 * A machine on the same LAN by wire and Wi-Fi routes its own traffic over the lower metric, so
 * advertising that interface's address keeps requests and replies on one link, and keeps names
 * working when the other link drops.
 */
export function defaultRouteInterfaces(
  readRoutes: () => string = () => readFileSync('/proc/net/route', 'utf8'),
): string[] {
  let table: string;
  try {
    table = readRoutes();
  } catch {
    return [];
  }
  return table
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (cols) =>
        cols.length >= 7 && cols[1] === '00000000' && (Number.parseInt(cols[3], 16) & 1) === 1,
    )
    .map((cols) => ({ name: cols[0], metric: Number(cols[6]) }))
    .sort((a, b) => a.metric - b.metric)
    .map((route) => route.name);
}

export function getLocalIPv4(
  interfaces = networkInterfaces(),
  routeOrder: string[] = defaultRouteInterfaces(),
): string {
  const configured = process.env.DEPLOY_MDNS_ADDRESS?.trim();
  if (configured) return configured;
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((iface) => iface.family === 'IPv4' && !iface.internal)
      .map((iface) => ({ name, address: iface.address })),
  );
  const virtual = /^(docker|br-|veth|utun|tun|tap|tailscale|wg|vmnet|vbox|colima)/i;
  const physical = /^(en\d+|enx\w+|eth\d+|eno\d+|ens\d+|enp\w+|wlan\d+|wlp\w+|bond\d+|br0)$/i;
  for (const name of routeOrder) {
    if (virtual.test(name)) continue;
    const routed = candidates.find((candidate) => candidate.name === name);
    if (routed) return routed.address;
  }
  const preferred = candidates.find(
    (candidate) => physical.test(candidate.name) && !virtual.test(candidate.name),
  );
  if (preferred) return preferred.address;
  const nonVirtual = candidates.find((candidate) => !virtual.test(candidate.name));
  if (nonVirtual) return nonVirtual.address;
  return '127.0.0.1';
}

// ── mDNS hostname registry ──────────────────────────────────────────────────

/**
 * A loopback answer sends every other machine on the network to itself (seen when a dev server
 * ran with DEPLOY_MDNS_ADDRESS=127.0.0.1 and Bazzite resolved deploy.local to its own host).
 * Never multicast one; local-only names belong in /etc/hosts.
 */
export function advertisable(ip: string) {
  return !/^127\./.test(ip) && ip !== '0.0.0.0';
}

/** Injectable transport/address source keeps lifecycle tests off the network. */
export function createMdnsRegistry(createResponder = multicastDns, getAddress = getLocalIPv4) {
  const registeredHosts = new Set<string>();
  const advertised = new Map<string, string>();
  const repeats = new Map<string, ReturnType<typeof setTimeout>>();
  let mdns: ReturnType<typeof multicastDns> | null = null;
  let address = '';
  let ready = false;
  let announcementTimer: ReturnType<typeof setInterval> | null = null;

  function cancelRepeat(hostname: string) {
    clearTimeout(repeats.get(hostname));
    repeats.delete(hostname);
  }

  function announce(hostname: string, repeat = false) {
    if (!mdns || !ready) return;
    const m = mdns;
    m.registerResponse(hostname, address, 120);
    advertised.set(hostname, address);
    // Use the same unique/cache-flush A + NSEC packet as query answers.
    m.respondRaw(buildARecordResponse(hostname, address, 120));
    if (repeat) {
      cancelRepeat(hostname);
      const timer = setTimeout(() => {
        repeats.delete(hostname);
        if (mdns === m && registeredHosts.has(hostname)) announce(hostname);
      }, 1000);
      timer.unref();
      repeats.set(hostname, timer);
    }
  }

  function withdraw(m: ReturnType<typeof multicastDns>, hostname: string, ip: string) {
    m.unregisterResponse(hostname);
    return new Promise<void>((resolve) => {
      m.respondRaw(buildARecordResponse(hostname, ip, 0), null, () => resolve());
    });
  }

  /**
   * `goodbye` withdraws every advertised name. Use it when the address changes, never on a plain
   * shutdown: a restart (self-update, crash guard) comes back within seconds, and goodbyes would
   * make every device drop deploy.local and app names until the new process announces again.
   */
  function retire(goodbye: boolean) {
    const m = mdns;
    mdns = null;
    ready = false;
    for (const hostname of repeats.keys()) cancelRepeat(hostname);
    const pending = m && goodbye ? [...advertised].map(([host, ip]) => withdraw(m, host, ip)) : [];
    advertised.clear();
    return Promise.all(pending).then(
      () =>
        new Promise<void>((resolve) => {
          if (m) m.destroy(resolve);
          else resolve();
        }),
    );
  }

  function refresh() {
    if (!announcementTimer) {
      announcementTimer = setInterval(() => {
        refresh();
        for (const host of registeredHosts) announce(host);
      }, 60_000);
      announcementTimer.unref();
    }
    const ip = getAddress();
    if (mdns && ip !== address) void retire(true);
    // In local-only mode do not even join the owner's multicast groups.
    if (!advertisable(ip)) return;
    if (!mdns) {
      address = ip;
      // Bind wildcard to receive multicast on Linux; join/send only on the
      // interface whose address is advertised, never Docker/VPN memberships.
      const m = createResponder({ interface: ip, bind: '0.0.0.0' });
      mdns = m;
      m.on('warning', (err) => console.warn(`mDNS warning: ${err.message}`));
      m.on('error', (err) => console.error(`mDNS error: ${err.message}`));
      m.on('ready', () => {
        if (mdns !== m) return;
        ready = true;
        for (const host of registeredHosts) announce(host, true);
      });
    }
  }

  function registerHost(name: string) {
    const hostname = `${name.toLowerCase()}.local`;
    const newlyRegistered = !registeredHosts.has(hostname);
    registeredHosts.add(hostname);
    refresh();
    announce(hostname, newlyRegistered);
    if (newlyRegistered) {
      const ip = getAddress();
      console.log(
        advertisable(ip)
          ? `mDNS: registered ${hostname} → ${ip}`
          : `mDNS: not advertising ${hostname} → ${ip} on the network; add it to /etc/hosts for local use`,
      );
    }
  }

  function unregisterHost(name: string) {
    const hostname = `${name.toLowerCase()}.local`;
    registeredHosts.delete(hostname);
    cancelRepeat(hostname);
    const ip = advertised.get(hostname);
    advertised.delete(hostname);
    if (mdns) {
      if (ip) void withdraw(mdns, hostname, ip);
      else mdns.unregisterResponse(hostname);
    }
  }

  async function stopMdns() {
    if (announcementTimer) clearInterval(announcementTimer);
    announcementTimer = null;
    registeredHosts.clear();
    await retire(false);
  }

  function registerAllDeployments(names: string[]) {
    for (const name of names) registerHost(name);
  }
  return { registerHost, unregisterHost, registerAllDeployments, stopMdns };
}
const registry = createMdnsRegistry();
export const { registerHost, unregisterHost, registerAllDeployments, stopMdns } = registry;
