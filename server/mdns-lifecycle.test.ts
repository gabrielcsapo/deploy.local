import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import { createMdnsRegistry, defaultRouteInterfaces, getLocalIPv4 } from './mdns.ts';
import type multicastDns from '@deploy.local/mdns';
import type { NetworkInterfaceInfo } from 'node:os';
import { decodeName } from '../packages/mdns/dns.ts';

let networks: Record<string, { family: string; address: string; internal: boolean }[]>;
const instances: FakeMdns[] = [];
const initialAddress = process.env.DEPLOY_MDNS_ADDRESS;
let activeRegistry: ReturnType<typeof createMdnsRegistry> | undefined;
afterEach(async () => {
  await activeRegistry?.stopMdns();
  if (initialAddress === undefined) delete process.env.DEPLOY_MDNS_ADDRESS;
  else process.env.DEPLOY_MDNS_ADDRESS = initialAddress;
});
class FakeMdns extends EventEmitter {
  packets: Buffer[] = [];
  records = new Map<string, string>();
  closed = false;
  holdSends = false;
  callbacks: (() => void)[] = [];
  options: { interface?: string };
  constructor(options: { interface?: string } = {}) {
    super();
    this.options = options;
    instances.push(this);
  }
  registerResponse(host: string, ip: string) {
    this.records.set(host, ip);
  }
  unregisterResponse(host: string) {
    this.records.delete(host);
  }
  respond() {
    this.packets.push(Buffer.alloc(12));
  }
  respondRaw(packet: Buffer, _target?: unknown, cb?: (err: Error | null) => void) {
    this.packets.push(packet);
    if (cb && this.holdSends) this.callbacks.push(() => cb(null));
    else cb?.(null);
  }
  destroy(cb?: () => void) {
    this.closed = true;
    cb?.();
  }
}
async function fixture() {
  delete process.env.DEPLOY_MDNS_ADDRESS;
  networks = { en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] };
  instances.length = 0;
  activeRegistry = createMdnsRegistry(
    ((options: { interface?: string }) => new FakeMdns(options)) as unknown as typeof multicastDns,
    () => getLocalIPv4(networks as Record<string, NetworkInterfaceInfo[]>, []),
  );
  return activeRegistry;
}
function ttl(packet: Buffer) {
  return packet.readUInt32BE(12 + decodeName(packet, 12)[1] + 4);
}

test('virtual-only interfaces do not become LAN addresses', async () => {
  await fixture();
  networks = Object.fromEntries(
    ['docker0', 'br-abcd', 'veth0', 'utun3', 'tailscale0', 'wg0'].map((name) => [
      name,
      [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    ]),
  );
  assert.equal(getLocalIPv4(networks as Record<string, NetworkInterfaceInfo[]>, []), '127.0.0.1');
});
test('loopback override starts no multicast socket', async () => {
  const registry = await fixture();
  process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
  registry.registerHost('test');
  assert.equal(instances.length, 0);
});
test('responder uses the selected LAN interface', async () => {
  const registry = await fixture();
  registry.registerHost('test');
  assert.equal(instances[0].options.interface, '192.168.1.20');
});
test('startup waits for readiness then announces twice with flush and NSEC', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const registry = await fixture();
  registry.registerHost('test');
  const instance = instances[0];
  assert.equal(instance.packets.length, 0);
  instance.emit('ready');
  assert.equal(instance.packets.length, 1);
  const packet = instance.packets[0];
  assert.equal(packet.readUInt16BE(10), 1);
  assert.equal(packet.readUInt16BE(12 + decodeName(packet, 12)[1] + 2), 0x8001);
  t.mock.timers.tick(1000);
  assert.equal(instance.packets.length, 2);
});
test('removal withdraws the advertised address with TTL zero', async () => {
  const registry = await fixture();
  registry.registerHost('test');
  const instance = instances[0];
  instance.emit('ready');
  instance.packets.length = 0;
  process.env.DEPLOY_MDNS_ADDRESS = '10.0.0.99';
  registry.unregisterHost('test');
  assert.equal(instance.packets.length, 1);
  const packet = instance.packets[0];
  assert.equal(ttl(packet), 0);
  const offset = 12 + decodeName(packet, 12)[1] + 10;
  assert.deepEqual([...packet.subarray(offset, offset + 4)], [192, 168, 1, 20]);
  assert.equal(instance.records.has('test.local'), false);
});
test('shutdown sends no goodbyes, so a restart keeps names in device caches', async () => {
  const registry = await fixture();
  registry.registerHost('deploy');
  registry.registerHost('test');
  const instance = instances[0];
  instance.emit('ready');
  instance.packets.length = 0;
  await registry.stopMdns();
  assert.equal(instance.closed, true);
  assert.equal(instance.packets.length, 0);
});

test('the default-route interface wins over Wi-Fi on the same LAN', () => {
  delete process.env.DEPLOY_MDNS_ADDRESS;
  // SER: Wi-Fi listed first, USB Ethernet (enx…) carries the lower-metric default route.
  const ser = {
    wlp194s0: [{ family: 'IPv4', address: '10.0.0.213', internal: false }],
    enx7855360332c9: [{ family: 'IPv4', address: '10.0.0.154', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
  } as unknown as Record<string, NetworkInterfaceInfo[]>;
  const routes = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'wlp194s0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    'enx7855360332c9\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  ].join('\n');
  const order = defaultRouteInterfaces(() => routes);
  assert.deepEqual(order, ['enx7855360332c9', 'wlp194s0']);
  assert.equal(getLocalIPv4(ser, order), '10.0.0.154');
  // Without a route table (macOS), USB Ethernet still counts as a physical interface.
  assert.equal(getLocalIPv4({ enx1: ser.enx7855360332c9, docker0: ser.docker0 }, []), '10.0.0.154');
  assert.deepEqual(
    defaultRouteInterfaces(() => {
      throw new Error('no /proc');
    }),
    [],
  );
});

test('address changes withdraw the old address and rejoin on the new interface', async () => {
  const registry = await fixture();
  registry.registerHost('deploy');
  const previous = instances[0];
  previous.emit('ready');
  previous.packets.length = 0;
  process.env.DEPLOY_MDNS_ADDRESS = '192.168.1.21';
  registry.registerHost('test');
  const current = instances[1];
  current.emit('ready');
  assert.equal(ttl(previous.packets[0]), 0);
  assert.equal(current.options.interface, '192.168.1.21');
  assert.deepEqual([...current.records.keys()], ['deploy.local', 'test.local']);
  await registry.stopMdns();
  assert.equal(previous.closed, true);
  assert.equal(current.closed, true);
});

test('removing a host cancels its second startup announcement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const registry = await fixture();
  registry.registerHost('test');
  const instance = instances[0];
  instance.emit('ready');
  registry.unregisterHost('test');
  assert.equal(instance.packets.length, 2);
  t.mock.timers.tick(1000);
  assert.equal(instance.packets.length, 2);
  await registry.stopMdns();
});

test('a LAN address appearing after startup is discovered by the refresh timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const registry = await fixture();
  networks = {};
  registry.registerHost('deploy');
  assert.equal(instances.length, 0);
  networks = { en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] };
  t.mock.timers.tick(60_000);
  assert.equal(instances.length, 1);
  instances[0].emit('ready');
  assert.equal(instances[0].records.has('deploy.local'), true);
  await registry.stopMdns();
});
