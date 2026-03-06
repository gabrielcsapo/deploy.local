import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  encodeName,
  encodeQuery,
  decodeName,
  decodeQuery,
  buildARecordResponse,
  buildNsecResponse,
  stampTransactionId,
  TYPE_A,
  TYPE_AAAA,
  TYPE_NSEC,
  CLASS_FLUSH,
  RESPONSE_FLAG,
  AUTHORITATIVE_ANSWER,
} from './dns.ts';
import multicastDns from './index.ts';

// ── dns.ts unit tests ───────────────────────────────────────────────────────

describe('dns codec', () => {
  it('encodeName / decodeName round-trips', () => {
    const name = 'myapp.local';
    const buf = encodeName(name);
    const [decoded, bytesRead] = decodeName(buf, 0);
    assert.equal(decoded, name);
    assert.equal(bytesRead, buf.length);
  });

  it('encodeQuery produces a valid query packet', () => {
    const buf = encodeQuery({
      id: 0x1234,
      questions: [{ name: 'test.local', type: 'AAAA' }],
    });

    const query = decodeQuery(buf);
    assert.ok(query);
    assert.equal(query.id, 0x1234);
    assert.equal(query.questions.length, 1);
    assert.equal(query.questions[0]!.name, 'test.local');
    assert.equal(query.questions[0]!.type, TYPE_AAAA);
  });

  it('buildARecordResponse has correct structure with NSEC additional', () => {
    const buf = buildARecordResponse('myapp.local', '192.168.1.100', 120);

    // Flags: response + authoritative
    assert.equal(buf.readUInt16BE(2), RESPONSE_FLAG | AUTHORITATIVE_ANSWER);
    // ANCOUNT = 1 (A record)
    assert.equal(buf.readUInt16BE(6), 1);
    // ARCOUNT = 1 (NSEC additional)
    assert.equal(buf.readUInt16BE(10), 1);

    // Answer: A record with cache-flush bit
    const [name, nameLen] = decodeName(buf, 12);
    assert.equal(name, 'myapp.local');
    assert.equal(buf.readUInt16BE(12 + nameLen), TYPE_A);
    assert.equal(buf.readUInt16BE(12 + nameLen + 2), CLASS_FLUSH);

    // IP = 192.168.1.100
    const rdataOffset = 12 + nameLen + 10;
    assert.equal(buf[rdataOffset], 192);
    assert.equal(buf[rdataOffset + 1], 168);
    assert.equal(buf[rdataOffset + 2], 1);
    assert.equal(buf[rdataOffset + 3], 100);

    // Additional: NSEC record (via compression pointer)
    const nsecOffset = rdataOffset + 4;
    // Compression pointer to name at offset 12
    assert.equal(buf.readUInt16BE(nsecOffset), 0xc00c);
    assert.equal(buf.readUInt16BE(nsecOffset + 2), TYPE_NSEC);
    assert.equal(buf.readUInt16BE(nsecOffset + 4), CLASS_FLUSH);

    // NSEC RDATA: next name (compression pointer) + type bitmap
    const nsecRdataOffset = nsecOffset + 12;
    assert.equal(buf.readUInt16BE(nsecRdataOffset), 0xc00c); // next name = self
    assert.equal(buf[nsecRdataOffset + 2], 0); // window 0
    assert.equal(buf[nsecRdataOffset + 3], 1); // bitmap length
    assert.equal(buf[nsecRdataOffset + 4], 0x40); // type A bit set
  });

  it('buildNsecResponse has correct structure', () => {
    const buf = buildNsecResponse('myapp.local', 120);

    // Flags: response + authoritative
    assert.equal(buf.readUInt16BE(2), RESPONSE_FLAG | AUTHORITATIVE_ANSWER);
    // ANCOUNT = 1
    assert.equal(buf.readUInt16BE(6), 1);

    const [name, nameLen] = decodeName(buf, 12);
    assert.equal(name, 'myapp.local');

    // TYPE = NSEC (47)
    const typeOffset = 12 + nameLen;
    assert.equal(buf.readUInt16BE(typeOffset), TYPE_NSEC);
    // CLASS = IN with cache-flush bit
    assert.equal(buf.readUInt16BE(typeOffset + 2), CLASS_FLUSH);
    // TTL = 120
    assert.equal(buf.readUInt32BE(typeOffset + 4), 120);

    // RDATA: next domain name should be the same hostname
    const rdataOffset = typeOffset + 10;
    const [nsecNextName] = decodeName(buf, rdataOffset);
    assert.equal(nsecNextName, 'myapp.local');

    // Type bitmap: window=0, length=1, bitmap=0x40 (A record only)
    const bitmapOffset = rdataOffset + encodeName('myapp.local').length;
    assert.equal(buf[bitmapOffset], 0); // window 0
    assert.equal(buf[bitmapOffset + 1], 1); // bitmap length
    assert.equal(buf[bitmapOffset + 2], 0x40); // type A bit set
  });

  it('stampTransactionId mutates buffer in place', () => {
    const buf = buildARecordResponse('x.local', '1.2.3.4', 60);
    assert.equal(buf.readUInt16BE(0), 0);
    stampTransactionId(buf, 0xabcd);
    assert.equal(buf.readUInt16BE(0), 0xabcd);
  });
});

// ── Integration: mDNS instance responds to A and AAAA queries ───────────────
//
// Uses socket interception to capture what the mDNS fast-path sends,
// without needing real multicast or UDP round-trips.

describe('mDNS NSEC response for AAAA queries', () => {
  let mdns: ReturnType<typeof multicastDns>;
  let sock: dgram.Socket;
  let sent: Buffer[];

  beforeEach(() => {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    mdns = multicastDns({
      socket: sock,
      port: 5353,
      ip: '127.0.0.1',
      multicast: false,
      bind: false,
    });

    mdns.registerResponse('testapp.local', '10.0.0.42', 120);

    // Intercept socket.send to capture outgoing responses
    sent = [];
    sock.send = function (buf: Buffer, offset: number, length: number) {
      sent.push(Buffer.from(buf.subarray(offset, offset + length)));
    } as any;
  });

  afterEach(() => {
    mdns.destroy();
  });

  function simulateQuery(name: string, type: string, id = 0x1234) {
    const queryBuf = encodeQuery({ id, questions: [{ name, type }] });
    const rinfo = {
      address: '127.0.0.1',
      family: 'IPv4' as const,
      port: 12345,
      size: queryBuf.length,
    };
    sock.emit('message', queryBuf, rinfo);
  }

  it('responds to A query with A record + NSEC additional', () => {
    simulateQuery('testapp.local', 'A');

    assert.equal(sent.length, 1);
    const response = sent[0]!;

    // Response flags
    assert.ok(response.readUInt16BE(2) & RESPONSE_FLAG);
    assert.ok(response.readUInt16BE(2) & AUTHORITATIVE_ANSWER);
    // ANCOUNT = 1, ARCOUNT = 1
    assert.equal(response.readUInt16BE(6), 1);
    assert.equal(response.readUInt16BE(10), 1);

    // Answer name
    const [name, nameLen] = decodeName(response, 12);
    assert.equal(name, 'testapp.local');

    // TYPE = A with cache-flush
    assert.equal(response.readUInt16BE(12 + nameLen), TYPE_A);
    assert.equal(response.readUInt16BE(12 + nameLen + 2), CLASS_FLUSH);

    // IP = 10.0.0.42
    const rdataOffset = 12 + nameLen + 10;
    assert.equal(response[rdataOffset], 10);
    assert.equal(response[rdataOffset + 1], 0);
    assert.equal(response[rdataOffset + 2], 0);
    assert.equal(response[rdataOffset + 3], 42);

    // Additional: NSEC record present
    const nsecOffset = rdataOffset + 4;
    const [nsecName] = decodeName(response, nsecOffset);
    assert.equal(nsecName, 'testapp.local');
  });

  it('responds to AAAA query with NSEC record', () => {
    simulateQuery('testapp.local', 'AAAA');

    assert.equal(sent.length, 1, 'should send exactly one response for AAAA query');
    const response = sent[0]!;

    // Response flags
    const flags = response.readUInt16BE(2);
    assert.ok(flags & RESPONSE_FLAG);
    assert.ok(flags & AUTHORITATIVE_ANSWER);
    // ANCOUNT = 1 (NSEC record)
    assert.equal(response.readUInt16BE(6), 1);

    // Answer name
    const [name, nameLen] = decodeName(response, 12);
    assert.equal(name, 'testapp.local');

    // TYPE = NSEC (47)
    assert.equal(response.readUInt16BE(12 + nameLen), TYPE_NSEC);
    // CLASS = IN with cache-flush bit
    assert.equal(response.readUInt16BE(12 + nameLen + 2), CLASS_FLUSH);

    // NSEC RDATA: next domain name = testapp.local (self)
    const rdataStart = 12 + nameLen + 10;
    const [nsecNextName, nextNameLen] = decodeName(response, rdataStart);
    assert.equal(nsecNextName, 'testapp.local');

    // Type bitmap: indicates only A exists
    const bitmapOffset = rdataStart + nextNameLen;
    assert.equal(response[bitmapOffset], 0); // window 0
    assert.equal(response[bitmapOffset + 1], 1); // bitmap length
    assert.equal(response[bitmapOffset + 2], 0x40); // type A bit set
  });

  it('does NOT respond to AAAA query for unregistered hostname', () => {
    simulateQuery('unknown.local', 'AAAA');
    assert.equal(sent.length, 0, 'should not respond for unregistered host');
  });

  it('responds to ANY query with A record', () => {
    simulateQuery('testapp.local', 'ANY');

    assert.equal(sent.length, 1);
    const response = sent[0]!;

    const [name, nameLen] = decodeName(response, 12);
    assert.equal(name, 'testapp.local');
    assert.equal(response.readUInt16BE(12 + nameLen), TYPE_A);
  });

  it('stamps correct transaction ID on response', () => {
    simulateQuery('testapp.local', 'AAAA', 0xbeef);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.readUInt16BE(0), 0xbeef);
  });

  it('handles both A and AAAA queries for the same host', () => {
    simulateQuery('testapp.local', 'A', 0x0001);
    simulateQuery('testapp.local', 'AAAA', 0x0002);

    assert.equal(sent.length, 2);

    // First response: A record (with NSEC additional)
    const [, nameLen1] = decodeName(sent[0]!, 12);
    assert.equal(sent[0]!.readUInt16BE(12 + nameLen1), TYPE_A);
    assert.equal(sent[0]!.readUInt16BE(0), 0x0001);
    assert.equal(sent[0]!.readUInt16BE(10), 1); // ARCOUNT = 1 (NSEC additional)

    // Second response: standalone NSEC record
    const [, nameLen2] = decodeName(sent[1]!, 12);
    assert.equal(sent[1]!.readUInt16BE(12 + nameLen2), TYPE_NSEC);
    assert.equal(sent[1]!.readUInt16BE(0), 0x0002);
  });

  it('stops responding after unregisterResponse', () => {
    mdns.unregisterResponse('testapp.local');

    simulateQuery('testapp.local', 'A');
    simulateQuery('testapp.local', 'AAAA');

    assert.equal(sent.length, 0, 'should not respond after unregister');
  });
});
