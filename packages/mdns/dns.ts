/**
 * Minimal DNS wire-format codec optimized for mDNS A-record queries/responses.
 * Handles only what mDNS needs: decoding question sections and encoding A-record answers.
 * ~10x faster than dns-packet for this use case by avoiding full packet parsing.
 */

// ── Constants ───────────────────────────────────────────────────────────────

const QUERY_FLAG = 0;
const RESPONSE_FLAG = 1 << 15;
const AUTHORITATIVE_ANSWER = 1 << 10;

// Record types
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_NSEC = 47;
const TYPE_ANY = 255;

// Class
const CLASS_IN = 1;
const CLASS_FLUSH = CLASS_IN | 0x8000; // 0x8001 — cache-flush bit for unique records

// ── Types ───────────────────────────────────────────────────────────────────

export interface DnsQuestion {
  name: string;
  type: number;
  class: number;
  /** QU (unicast-response requested) bit from class field */
  qu: boolean;
}

export interface DnsHeader {
  id: number;
  flags: number;
  isQuery: boolean;
  qdcount: number;
  ancount: number;
}

export interface DecodedQuery {
  id: number;
  questions: DnsQuestion[];
}

export {
  TYPE_A,
  TYPE_AAAA,
  TYPE_NSEC,
  TYPE_ANY,
  AUTHORITATIVE_ANSWER,
  RESPONSE_FLAG,
  QUERY_FLAG,
  CLASS_IN,
  CLASS_FLUSH,
};

// ── Name decoding ───────────────────────────────────────────────────────────

/**
 * Decode a DNS name from a buffer, handling label sequences and compression pointers.
 * Returns the decoded name and the number of bytes consumed.
 */
export function decodeName(buf: Buffer, offset: number): [name: string, bytesRead: number] {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let jumpCount = 0;
  let bytesRead = 0;

  while (pos < buf.length) {
    const len = buf[pos]!;

    if (len === 0) {
      // End of name
      if (!jumped) bytesRead = pos - offset + 1;
      break;
    }

    // Compression pointer (top 2 bits set)
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) bytesRead = pos - offset + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1]!;
      jumped = true;
      if (++jumpCount > 255) throw new Error('DNS name compression loop');
      continue;
    }

    pos++;
    labels.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }

  if (!jumped && bytesRead === 0) bytesRead = pos - offset + 1;
  return [labels.join('.'), bytesRead];
}

// ── Name encoding ───────────────────────────────────────────────────────────

/**
 * Encode a DNS name into label format. Returns the buffer.
 */
export function encodeName(name: string): Buffer {
  const labels = name.split('.');
  // Each label: 1 byte length + label bytes, plus 1 byte null terminator
  let size = 1; // null terminator
  for (const label of labels) size += 1 + Buffer.byteLength(label);

  const buf = Buffer.allocUnsafe(size);
  let offset = 0;

  for (const label of labels) {
    const len = Buffer.byteLength(label);
    buf[offset++] = len;
    buf.write(label, offset);
    offset += len;
  }
  buf[offset] = 0;

  return buf;
}

// ── Decode query (minimal — only parses header + questions) ─────────────────

/**
 * Fast-path decoder: only extracts the header and question section.
 * Skips answer/authority/additional sections entirely.
 */
export function decodeQuery(buf: Buffer): DecodedQuery | null {
  if (buf.length < 12) return null;

  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);

  // Check if this is a query (QR bit = 0)
  if (flags & RESPONSE_FLAG) return null;

  const qdcount = buf.readUInt16BE(4);
  if (qdcount === 0) return null;

  const questions: DnsQuestion[] = [];
  let offset = 12;

  for (let i = 0; i < qdcount && offset < buf.length; i++) {
    const [name, bytesRead] = decodeName(buf, offset);
    offset += bytesRead;

    if (offset + 4 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const cls = buf.readUInt16BE(offset + 2);
    offset += 4;

    questions.push({ name, type, class: cls & 0x7fff, qu: !!(cls & 0x8000) });
  }

  return { id, questions };
}

// ── Encode A-record response ────────────────────────────────────────────────

/**
 * Pre-build a response buffer template for an A record with NSEC additional.
 * The transaction ID (bytes 0-1) should be stamped at send time.
 *
 * Includes an NSEC additional record denying AAAA, so the resolver gets
 * both the address and "no IPv6" signal in a single packet — preventing
 * the ~5s AAAA timeout on macOS.
 *
 * Uses CLASS_FLUSH (cache-flush bit) so resolvers treat these as unique records.
 *
 * Layout:
 *   [0-1]    Transaction ID (placeholder 0x0000)
 *   [2-3]    Flags: Response + Authoritative Answer
 *   [4-5]    QDCOUNT = 0
 *   [6-7]    ANCOUNT = 1 (A record)
 *   [8-9]    NSCOUNT = 0
 *   [10-11]  ARCOUNT = 1 (NSEC additional)
 *   [12...]  Answer: name + A record
 *   [...]    Additional: NSEC record (compression pointer to name)
 */
export function buildARecordResponse(name: string, ip: string, ttl: number): Buffer {
  const encodedName = encodeName(name);
  const ipParts = ip.split('.').map(Number);

  // NSEC RDATA: compression pointer to name (2) + type bitmap (3) = 5 bytes
  const nsecRdataLen = 2 + 3;
  // Additional NSEC: ptr(2) + type(2) + class(2) + ttl(4) + rdlen(2) + rdata(5) = 17 bytes
  const additionalSize = 2 + 2 + 2 + 4 + 2 + nsecRdataLen;

  // Header(12) + name + A answer(14) + NSEC additional(17)
  const size = 12 + encodedName.length + 14 + additionalSize;
  const buf = Buffer.allocUnsafe(size);

  // Header
  buf.writeUInt16BE(0, 0); // Transaction ID (placeholder)
  buf.writeUInt16BE(RESPONSE_FLAG | AUTHORITATIVE_ANSWER, 2); // Flags
  buf.writeUInt16BE(0, 4); // QDCOUNT
  buf.writeUInt16BE(1, 6); // ANCOUNT = 1 (A record)
  buf.writeUInt16BE(0, 8); // NSCOUNT
  buf.writeUInt16BE(1, 10); // ARCOUNT = 1 (NSEC additional)

  // Answer: A record
  let offset = 12;
  encodedName.copy(buf, offset);
  offset += encodedName.length;

  buf.writeUInt16BE(TYPE_A, offset); // TYPE
  buf.writeUInt16BE(CLASS_FLUSH, offset + 2); // CLASS with cache-flush bit
  buf.writeUInt32BE(ttl, offset + 4); // TTL
  buf.writeUInt16BE(4, offset + 8); // RDLENGTH
  buf[offset + 10] = ipParts[0]!; // IPv4 byte 1
  buf[offset + 11] = ipParts[1]!; // IPv4 byte 2
  buf[offset + 12] = ipParts[2]!; // IPv4 byte 3
  buf[offset + 13] = ipParts[3]!; // IPv4 byte 4
  offset += 14;

  // Additional: NSEC record (denying AAAA for this name)
  buf.writeUInt16BE(0xc00c, offset); // Compression pointer to name at offset 12
  offset += 2;
  buf.writeUInt16BE(TYPE_NSEC, offset); // TYPE = NSEC
  buf.writeUInt16BE(CLASS_FLUSH, offset + 2); // CLASS with cache-flush bit
  buf.writeUInt32BE(ttl, offset + 4); // TTL
  buf.writeUInt16BE(nsecRdataLen, offset + 8); // RDLENGTH
  offset += 10;

  // NSEC RDATA: next domain name (self, via compression pointer) + type bitmap
  buf.writeUInt16BE(0xc00c, offset); // Pointer to name at offset 12
  offset += 2;
  buf[offset] = 0; // Window block 0 (covers types 0–255)
  buf[offset + 1] = 1; // Bitmap length = 1 byte
  buf[offset + 2] = 0x40; // Bit 1 set (type A) — MSB is type 0, next bit is type 1

  return buf;
}

/**
 * Pre-build a negative NSEC response for AAAA queries.
 * Tells the resolver "this name exists but only has A records, not AAAA".
 * Prevents ~5s resolver timeout waiting for an IPv6 address that doesn't exist.
 *
 * RFC 6762 Section 6.1: NSEC records signal the absence of record types.
 */
export function buildNsecResponse(name: string, ttl: number): Buffer {
  const encodedName = encodeName(name);

  // NSEC RDATA: next domain name (self) + type bit map
  // Type bit map for "only A exists": window=0, length=1, bitmap=0x40
  const nsecRdataLength = encodedName.length + 3;

  // Header (12) + name + type(2) + class(2) + ttl(4) + rdlength(2) + rdata
  const size = 12 + encodedName.length + 2 + 2 + 4 + 2 + nsecRdataLength;
  const buf = Buffer.allocUnsafe(size);

  // Header
  buf.writeUInt16BE(0, 0); // Transaction ID (placeholder)
  buf.writeUInt16BE(RESPONSE_FLAG | AUTHORITATIVE_ANSWER, 2); // Flags
  buf.writeUInt16BE(0, 4); // QDCOUNT
  buf.writeUInt16BE(1, 6); // ANCOUNT = 1 (NSEC record)
  buf.writeUInt16BE(0, 8); // NSCOUNT
  buf.writeUInt16BE(0, 10); // ARCOUNT

  // NSEC Answer
  let offset = 12;
  encodedName.copy(buf, offset);
  offset += encodedName.length;

  buf.writeUInt16BE(TYPE_NSEC, offset); // TYPE = NSEC (47)
  buf.writeUInt16BE(CLASS_FLUSH, offset + 2); // CLASS with cache-flush bit
  buf.writeUInt32BE(ttl, offset + 4); // TTL
  buf.writeUInt16BE(nsecRdataLength, offset + 8); // RDLENGTH
  offset += 10;

  // NSEC RDATA: next domain name (points to itself — standard for mDNS)
  encodedName.copy(buf, offset);
  offset += encodedName.length;

  // NSEC RDATA: type bit map — indicates only A (type 1) exists
  buf[offset] = 0; // Window block 0 (covers types 0–255)
  buf[offset + 1] = 1; // Bitmap length = 1 byte
  buf[offset + 2] = 0x40; // Bit 1 set (type A) — MSB is type 0, next bit is type 1

  return buf;
}

/**
 * Stamp a transaction ID into a pre-built response buffer and return it.
 * Mutates the buffer in-place for zero-copy performance.
 */
export function stampTransactionId(buf: Buffer, id: number): Buffer {
  buf.writeUInt16BE(id, 0);
  return buf;
}

// ── General-purpose encode (for sending queries) ────────────────────────────

export interface OutgoingQuery {
  id?: number;
  questions: Array<{ name: string; type: string | number }>;
}

export interface OutgoingResponse {
  id?: number;
  answers: Array<{ name: string; type: string; data: string; ttl?: number }>;
}

function typeToNumber(type: string | number): number {
  if (typeof type === 'number') return type;
  switch (type.toUpperCase()) {
    case 'A':
      return 1;
    case 'AAAA':
      return 28;
    case 'PTR':
      return 12;
    case 'SRV':
      return 33;
    case 'TXT':
      return 16;
    case 'ANY':
      return 255;
    default:
      return 255;
  }
}

export function encodeQuery(q: OutgoingQuery): Buffer {
  const id = q.id ?? 0;
  const questions = q.questions;

  // Calculate size
  let size = 12; // header
  const encodedNames: Buffer[] = [];
  for (const question of questions) {
    const name = encodeName(question.name);
    encodedNames.push(name);
    size += name.length + 4; // name + type(2) + class(2)
  }

  const buf = Buffer.allocUnsafe(size);
  buf.writeUInt16BE(id, 0);
  buf.writeUInt16BE(QUERY_FLAG, 2);
  buf.writeUInt16BE(questions.length, 4);
  buf.writeUInt16BE(0, 6);
  buf.writeUInt16BE(0, 8);
  buf.writeUInt16BE(0, 10);

  let offset = 12;
  for (let i = 0; i < questions.length; i++) {
    encodedNames[i]!.copy(buf, offset);
    offset += encodedNames[i]!.length;
    buf.writeUInt16BE(typeToNumber(questions[i]!.type), offset);
    buf.writeUInt16BE(CLASS_IN, offset + 2);
    offset += 4;
  }

  return buf;
}

export function encodeResponse(r: OutgoingResponse): Buffer {
  const id = r.id ?? 0;
  const answers = r.answers;

  // Calculate size
  let size = 12; // header
  const parts: Array<{ name: Buffer; ip: number[] }> = [];
  for (const answer of answers) {
    const name = encodeName(answer.name);
    const ipParts = answer.data.split('.').map(Number);
    parts.push({ name, ip: ipParts });
    size += name.length + 2 + 2 + 4 + 2 + 4; // name + type + class + ttl + rdlen + rdata
  }

  const buf = Buffer.allocUnsafe(size);
  buf.writeUInt16BE(id, 0);
  buf.writeUInt16BE(RESPONSE_FLAG | AUTHORITATIVE_ANSWER, 2);
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(answers.length, 6);
  buf.writeUInt16BE(0, 8);
  buf.writeUInt16BE(0, 10);

  let offset = 12;
  for (let i = 0; i < answers.length; i++) {
    const { name, ip } = parts[i]!;
    const answer = answers[i]!;

    name.copy(buf, offset);
    offset += name.length;
    buf.writeUInt16BE(TYPE_A, offset);
    buf.writeUInt16BE(CLASS_IN, offset + 2);
    buf.writeUInt32BE(answer.ttl ?? 120, offset + 4);
    buf.writeUInt16BE(4, offset + 8);
    buf[offset + 10] = ip[0]!;
    buf[offset + 11] = ip[1]!;
    buf[offset + 12] = ip[2]!;
    buf[offset + 13] = ip[3]!;
    offset += 14;
  }

  return buf;
}
