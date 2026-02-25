/**
 * Low level multicast-dns implementation in TypeScript.
 * Vendored and converted from https://github.com/mafintosh/multicast-dns (MIT)
 *
 * Optimized for mDNS A-record responder use case:
 * - Inline minimal DNS codec (no dns-packet dependency)
 * - Pre-encoded response buffers per registered host
 * - Fast-path query handler bypasses EventEmitter + object allocation
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import {
  decodeQuery,
  buildARecordResponse,
  buildNsecResponse,
  stampTransactionId,
  encodeResponse,
  encodeQuery,
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
} from './dns.ts';

import type { RemoteInfo, Socket, SocketType } from 'node:dgram';
import type { DnsQuestion } from './dns.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface Options {
  port?: number;
  type?: SocketType;
  ip?: string;
  host?: string;
  interface?: string;
  socket?: Socket;
  reuseAddr?: boolean;
  bind?: false | string;
  multicast?: boolean;
  ttl?: number;
  loopback?: boolean;
}

export interface QueryPacket {
  id: number;
  questions: DnsQuestion[];
}

export interface ResponseOutgoingPacket {
  answers: Array<{ name: string; type: string; data: string; ttl?: number }>;
}

export interface RemoteInfoOutgoing {
  port: number;
  address?: string;
  host?: string;
}

type Callback = (error: Error | null, bytes?: number) => void;

export type QueryHandler = (query: QueryPacket, rinfo: RemoteInfo) => void;

export interface MulticastDNS extends EventEmitter {
  send(buf: Buffer, rinfo?: RemoteInfoOutgoing | null, cb?: Callback): void;
  query(name: string, type?: string, rinfo?: RemoteInfoOutgoing | null, cb?: Callback): void;
  respond(response: ResponseOutgoingPacket, rinfo?: RemoteInfoOutgoing | null, cb?: Callback): void;
  respondRaw(buf: Buffer, rinfo?: RemoteInfoOutgoing | null, cb?: Callback): void;
  destroy(cb?: () => void): void;
  update(): void;

  /** Register a pre-encoded A record response for fast-path replies */
  registerResponse(hostname: string, ip: string, ttl?: number): void;
  /** Unregister a pre-encoded response */
  unregisterResponse(hostname: string): void;

  on(event: 'ready', listener: () => void): this;
  on(event: 'query', listener: (query: QueryPacket, rinfo: RemoteInfo) => void): this;
  on(event: 'warning', listener: (err: Error) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'networkInterface', listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  emit(event: 'ready'): boolean;
  emit(event: 'query', query: QueryPacket, rinfo: RemoteInfo): boolean;
  emit(event: 'warning', err: Error): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'networkInterface'): boolean;
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const noop = () => {};

function defaultInterface(): string {
  const networks = os.networkInterfaces();
  const names = Object.keys(networks);

  for (const name of names) {
    const net = networks[name]!;
    for (const iface of net) {
      if (isIPv4(iface.family) && !iface.internal) {
        if (os.platform() === 'darwin' && name === 'en0') return iface.address;
        return '0.0.0.0';
      }
    }
  }

  return '127.0.0.1';
}

function allInterfaces(): string[] {
  const networks = os.networkInterfaces();
  const names = Object.keys(networks);
  const res: string[] = [];

  for (const name of names) {
    const net = networks[name]!;
    for (const iface of net) {
      if (isIPv4(iface.family)) {
        res.push(iface.address);
        break;
      }
    }
  }

  return res;
}

function isIPv4(family: string | number): boolean {
  return family === 4 || family === 'IPv4';
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function multicastDns(opts?: Options): MulticastDNS {
  const options = opts ?? {};

  const that = new EventEmitter() as MulticastDNS;
  let port = typeof options.port === 'number' ? options.port : 5353;
  const type = options.type ?? 'udp4';
  const ip = options.ip ?? options.host ?? (type === 'udp4' ? '224.0.0.251' : null);
  const me = { address: ip, port };
  let memberships: Record<string, boolean> = {};
  let destroyed = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  // Pre-encoded response cache: hostname → Buffer
  const responseCache = new Map<string, Buffer>();
  // Pre-encoded NSEC negative responses for AAAA queries: hostname → Buffer
  const nsecCache = new Map<string, Buffer>();

  if (type === 'udp6' && (!ip || !options.interface)) {
    throw new Error('For IPv6 multicast you must specify `ip` and `interface`');
  }

  const socket = options.socket ?? dgram.createSocket({
    type,
    reuseAddr: options.reuseAddr !== false,
    toString() {
      return type;
    },
  } as dgram.SocketOptions);

  // Track bind state for synchronous fast-path
  let bound = false;

  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') that.emit('error', err);
    else that.emit('warning', err);
  });

  socket.on('message', (message: Buffer, rinfo: RemoteInfo) => {
    // Fast-path: try to decode as query and respond from cache
    const query = decodeQuery(message);
    if (!query) return; // not a query or malformed — skip

    // Check cache for pre-encoded responses
    let responded = false;
    for (const q of query.questions) {
      if (q.type === TYPE_A || q.type === TYPE_ANY) {
        const cached = responseCache.get(q.name);
        if (cached) {
          // Stamp transaction ID and send directly — zero allocation
          stampTransactionId(cached, query.id);
          socket.send(cached, 0, cached.length, me.port, me.address!);
          responded = true;
        }
      } else if (q.type === TYPE_AAAA) {
        // Respond with NSEC to signal "no AAAA, only A" — prevents ~5s resolver timeout
        const cached = nsecCache.get(q.name);
        if (cached) {
          stampTransactionId(cached, query.id);
          socket.send(cached, 0, cached.length, me.port, me.address!);
          responded = true;
        }
      }
    }

    // Emit for any additional listeners (e.g., custom record types)
    if (that.listenerCount('query') > 0) {
      that.emit('query', query, rinfo);
    }

    if (!responded && that.listenerCount('query') === 0) {
      // No cache hit and no listeners — nothing to do
    }
  });

  socket.on('listening', () => {
    bound = true;
    if (!port) port = me.port = socket.address().port;
    if (options.multicast !== false) {
      that.update();
      interval = setInterval(that.update, 5000);
      socket.setMulticastTTL(options.ttl ?? 255);
      socket.setMulticastLoopback(options.loopback !== false);
    }
  });

  // Bind once
  let bindDone = false;
  let bindError: Error | null = null;
  let bindQueue: Array<(err: Error | null) => void> | null = [];

  function bind(cb: (err: Error | null) => void) {
    if (bindDone) return cb(bindError);
    if (bindQueue) {
      bindQueue.push(cb);
      if (bindQueue.length > 1) return;
    }

    if (!port || options.bind === false) {
      bindDone = true;
      const queue = bindQueue!;
      bindQueue = null;
      for (const fn of queue) fn(null);
      return;
    }

    socket.once('error', onBindError);
    socket.bind(port, options.bind || options.interface, () => {
      socket.removeListener('error', onBindError);
      bindDone = true;
      const queue = bindQueue!;
      bindQueue = null;
      for (const fn of queue) fn(null);
    });

    function onBindError(err: Error) {
      bindDone = true;
      bindError = err;
      const queue = bindQueue!;
      bindQueue = null;
      for (const fn of queue) fn(err);
    }
  }

  bind((err) => {
    if (err) return that.emit('error', err);
    that.emit('ready');
  });

  // ── Public API ──────────────────────────────────────────────────────────

  /** Register a pre-encoded A record response for instant cache replies */
  that.registerResponse = function (hostname: string, responseIp: string, ttl = 120) {
    responseCache.set(hostname, buildARecordResponse(hostname, responseIp, ttl));
    // Also cache an NSEC negative response for AAAA queries to prevent resolver timeouts
    nsecCache.set(hostname, buildNsecResponse(hostname, ttl));
  };

  /** Unregister a cached response */
  that.unregisterResponse = function (hostname: string) {
    responseCache.delete(hostname);
    nsecCache.delete(hostname);
  };

  /** Send a raw buffer */
  that.send = function (buf: Buffer, rinfo?: RemoteInfoOutgoing | Callback | null, cb?: Callback) {
    if (typeof rinfo === 'function') { cb = rinfo; rinfo = null; }
    if (!cb) cb = noop;
    const target = rinfo ?? me as RemoteInfoOutgoing;

    if (bound) {
      socket.send(buf, 0, buf.length, target.port, target.address ?? target.host ?? me.address!, cb);
      return;
    }

    const callback = cb;
    bind((err) => {
      if (destroyed) return callback(null);
      if (err) return callback(err);
      socket.send(buf, 0, buf.length, target.port, target.address ?? target.host ?? me.address!, callback);
    });
  };

  /** Send a pre-built response buffer directly (fastest path) */
  that.respondRaw = function (buf: Buffer, rinfo?: RemoteInfoOutgoing | null, cb?: Callback) {
    that.send(buf, rinfo, cb);
  };

  /** Encode and send a response */
  that.respond = function (
    res: ResponseOutgoingPacket,
    rinfo?: RemoteInfoOutgoing | Callback | null,
    cb?: Callback,
  ) {
    if (typeof rinfo === 'function') { cb = rinfo; rinfo = null; }
    const buf = encodeResponse({ answers: res.answers });
    that.send(buf, rinfo as RemoteInfoOutgoing | null, cb);
  };

  /** Encode and send a query */
  that.query = function (
    name: string,
    type?: string | RemoteInfoOutgoing | Callback | null,
    rinfo?: RemoteInfoOutgoing | Callback | null,
    cb?: Callback,
  ) {
    if (typeof type === 'function') { cb = type as Callback; type = null; rinfo = null; }
    if (typeof type === 'object' && type && 'port' in type) { cb = rinfo as Callback; rinfo = type; type = null; }
    if (typeof rinfo === 'function') { cb = rinfo; rinfo = null; }

    const buf = encodeQuery({
      questions: [{ name, type: type as string || 'ANY' }],
    });
    that.send(buf, rinfo as RemoteInfoOutgoing | null, cb);
  };

  that.destroy = function (cb?: () => void) {
    if (!cb) cb = noop;
    if (destroyed) return process.nextTick(cb);
    destroyed = true;
    if (interval) clearInterval(interval);

    for (const iface in memberships) {
      try {
        socket.dropMembership(ip!, iface);
      } catch {
        // eat it
      }
    }
    memberships = {};
    socket.close(cb);
  };

  that.update = function () {
    const ifaces = options.interface ? ([] as string[]).concat(options.interface) : allInterfaces();
    let updated = false;

    for (const addr of ifaces) {
      if (memberships[addr]) continue;

      try {
        socket.addMembership(ip!, addr);
        memberships[addr] = true;
        updated = true;
      } catch (err) {
        that.emit('warning', err as Error);
      }
    }

    if (updated) {
      try {
        socket.setMulticastInterface(options.interface ?? defaultInterface());
      } catch (err) {
        that.emit('warning', err as Error);
      }
      that.emit('networkInterface');
    }
  };

  return that;
}
