/**
 * DER 编解码
 *
 * X.509 证书是 DER 编码的 ASN.1。要做**真的**链验证 —— 签名验得过、SAN 对得上、
 * 有效期在范围内 —— 就绕不开它。自己写而不是引库的原因：浏览器里的
 * `crypto.subtle` 是异步的，而且我们只需要 DER 的一个很小的子集
 * （SEQUENCE / INTEGER / BIT STRING / OID / 时间 / UTF8String），
 * 几百行能写完，还能保证两端行为一致。
 */

export interface Asn1Node {
  tag: number;
  /** 构造类型的子节点 */
  children?: Asn1Node[];
  /** 原始内容（不含 tag 与长度） */
  value: Uint8Array;
  /** 这个节点在原始字节里的范围，验签要用「被签名的那一段原文」 */
  start: number;
  end: number;
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

const CONSTRUCTED = 0x20;

export function parseDer(bytes: Uint8Array, offset = 0): Asn1Node {
  const start = offset;
  const tag = bytes[offset++];
  let length = bytes[offset++];

  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('DER: 不支持的长度形式');
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[offset++];
  }

  const contentStart = offset;
  const end = contentStart + length;
  const value = bytes.subarray(contentStart, end);

  const node: Asn1Node = { tag, value, start, end };
  if ((tag & CONSTRUCTED) !== 0) {
    node.children = [];
    let cursor = contentStart;
    while (cursor < end) {
      const child = parseDer(bytes, cursor);
      node.children.push(child);
      cursor = child.end;
    }
  }
  return node;
}

/* ---------------- 编码 ---------------- */

export function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8; }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

export function encode(tag: number, content: Uint8Array): Uint8Array {
  const length = encodeLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** 非负整数，最高位是 1 时要补一个 0x00，否则会被当成负数 */
export function encodeInteger(value: bigint): Uint8Array {
  if (value === 0n) return encode(TAG.INTEGER, Uint8Array.from([0]));
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0n) { bytes.unshift(Number(remaining & 0xffn)); remaining >>= 8n; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return encode(TAG.INTEGER, Uint8Array.from(bytes));
}

export function decodeInteger(node: Asn1Node): bigint {
  let value = 0n;
  for (const byte of node.value) value = (value << 8n) | BigInt(byte);
  return value;
}

/** `1.2.840.113549.1.1.11` 这种 */
export function encodeOid(oid: string): Uint8Array {
  const parts = oid.split('.').map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let value = part;
    do { chunk.unshift(value & 0x7f); value >>>= 7; } while (value > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return encode(TAG.OID, Uint8Array.from(bytes));
}

export function decodeOid(node: Asn1Node): string {
  const bytes = node.value;
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    value = (value << 7) | (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}

/** UTCTime：`260302090000Z` */
export function encodeUtcTime(epochMs: number): Uint8Array {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const text = [
    pad(date.getUTCFullYear() % 100),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    'Z',
  ].join('');
  return encode(TAG.UTC_TIME, new TextEncoder().encode(text));
}

export function decodeUtcTime(node: Asn1Node): number {
  const text = new TextDecoder().decode(node.value);
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) return Number.NaN;
  const [, yy, mm, dd, hh, mi, ss] = match.map(Number) as unknown as number[];
  // RFC 5280：50 以上算 19xx，以下算 20xx
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return Date.UTC(year, mm - 1, dd, hh, mi, ss);
}

export function encodeBitString(content: Uint8Array): Uint8Array {
  return encode(TAG.BIT_STRING, concat(Uint8Array.from([0]), content));
}

/** 带上下文标签的显式包装，`[0] { ... }` */
export function explicit(index: number, content: Uint8Array): Uint8Array {
  return encode(0xa0 | index, content);
}
