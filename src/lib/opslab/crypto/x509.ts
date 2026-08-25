/**
 * X.509 证书：真的签、真的验
 *
 * 第 9 关整关压在这里，而它要教的东西恰恰是「看起来没问题但验不过」的几种：
 * 中间证书没带全、SAN 里没有这个名字、过期了、自签的没进信任库。这四种
 * 在浏览器里报的错完全不同，能分清才谈得上会查。
 *
 * 所以证书是**真的 DER**、签名是**真的 RSA**、验证是**真的链验证**。
 * 学员导出来的 PEM 拿去喂 `openssl x509 -text` 也读得懂。
 */
import {
  Asn1Node, TAG, concat, decodeInteger, decodeOid, decodeUtcTime, encode,
  encodeBitString, encodeInteger, encodeOid, encodeUtcTime, explicit, parseDer,
} from './asn1';
import { keyFor, type RsaKeyPair } from './keys';
import { base64urlToBytes, bytesToBigInt, sign, verify } from './rsa';

const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

export interface CertificateSpec {
  /** CN */
  commonName: string;
  organization?: string;
  /** DNS 名字与 IP，现代验证器只看这里，不看 CN */
  dnsNames?: string[];
  ipAddresses?: string[];
  /** 有效期 */
  notBefore: number;
  notAfter: number;
  isCa?: boolean;
  /** CA 证书往下还能签几层 */
  pathLength?: number;
  serial?: bigint;
  /** 客户端证书 / 服务端证书 */
  usages?: Array<'serverAuth' | 'clientAuth'>;
}

export interface Certificate {
  /** DER 字节 */
  der: Uint8Array;
  pem: string;
  subject: { commonName: string; organization?: string };
  issuer: { commonName: string; organization?: string };
  serial: bigint;
  notBefore: number;
  notAfter: number;
  dnsNames: string[];
  ipAddresses: string[];
  isCa: boolean;
  pathLength?: number;
  usages: string[];
  /** 公钥（base64url 的 n / e），验下一级时要用 */
  publicKey: { n: string; e: string };
}

export interface IssuedCertificate extends Certificate {
  /** 私钥的 PEM。真集群里它进 Secret 的 tls.key。 */
  privateKeyPem: string;
  key: RsaKeyPair;
}

/* ------------------------------------------------------------------ */
/* 签发                                                                */
/* ------------------------------------------------------------------ */

/**
 * 签一张证书。
 *
 * `issuer` 不给就是自签（根 CA）。密钥从固定池子里按名字取，
 * 所以同一个名字每次拿到同一对，重放才可能逐字节一致。
 */
export function issueCertificate(
  spec: CertificateSpec,
  issuer?: { certificate: Certificate; key: RsaKeyPair }
): IssuedCertificate {
  const key = keyFor(`${spec.commonName}|${spec.notBefore}`);
  const serial = spec.serial ?? BigInt(hash(`${spec.commonName}|${spec.notBefore}`)) + 1n;

  const subjectName = encodeName(spec.commonName, spec.organization);
  const issuerName = issuer
    ? encodeName(issuer.certificate.subject.commonName, issuer.certificate.subject.organization)
    : subjectName;

  const tbs = encode(TAG.SEQUENCE, concat(
    explicit(0, encodeInteger(2n)),               // v3
    encodeInteger(serial),
    algorithmIdentifier(),
    issuerName,
    encode(TAG.SEQUENCE, concat(
      encodeUtcTime(spec.notBefore),
      encodeUtcTime(spec.notAfter)
    )),
    subjectName,
    encodePublicKey(key),
    explicit(3, encode(TAG.SEQUENCE, concat(...extensionsOf(spec))))
  ));

  const signingKey = issuer?.key ?? key;
  const signature = sign(signingKey, tbs);
  const der = encode(TAG.SEQUENCE, concat(tbs, algorithmIdentifier(), encodeBitString(signature)));

  return {
    ...parseCertificate(der),
    privateKeyPem: encodePrivateKeyPem(key),
    key,
  };
}

function extensionsOf(spec: CertificateSpec): Uint8Array[] {
  const out: Uint8Array[] = [];

  out.push(extension(OID.basicConstraints, true, encode(TAG.SEQUENCE, spec.isCa
    ? concat(
      encode(TAG.BOOLEAN, Uint8Array.from([0xff])),
      ...(spec.pathLength !== undefined ? [encodeInteger(BigInt(spec.pathLength))] : [])
    )
    : new Uint8Array(0))));

  const usages = spec.usages ?? (spec.isCa ? [] : ['serverAuth']);
  if (usages.length > 0) {
    out.push(extension(OID.extKeyUsage, false, encode(TAG.SEQUENCE, concat(
      ...usages.map((usage) => encodeOid(usage === 'serverAuth' ? OID.serverAuth : OID.clientAuth))
    ))));
  }

  const names = [
    ...(spec.dnsNames ?? []).map((name) => encode(0x82, new TextEncoder().encode(name))),
    ...(spec.ipAddresses ?? []).map((ip) => encode(0x87, Uint8Array.from(ip.split('.').map(Number)))),
  ];
  if (names.length > 0) {
    out.push(extension(OID.subjectAltName, false, encode(TAG.SEQUENCE, concat(...names))));
  }
  return out;
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return encode(TAG.SEQUENCE, concat(
    encodeOid(oid),
    ...(critical ? [encode(TAG.BOOLEAN, Uint8Array.from([0xff]))] : []),
    encode(TAG.OCTET_STRING, value)
  ));
}

function algorithmIdentifier(): Uint8Array {
  return encode(TAG.SEQUENCE, concat(encodeOid(OID.sha256WithRsa), encode(TAG.NULL, new Uint8Array(0))));
}

function encodeName(commonName: string, organization?: string): Uint8Array {
  const rdns: Uint8Array[] = [];
  if (organization) rdns.push(rdn(OID.organization, organization));
  rdns.push(rdn(OID.commonName, commonName));
  return encode(TAG.SEQUENCE, concat(...rdns));
}

function rdn(oid: string, value: string): Uint8Array {
  return encode(TAG.SET, encode(TAG.SEQUENCE, concat(
    encodeOid(oid),
    encode(TAG.UTF8_STRING, new TextEncoder().encode(value))
  )));
}

function encodePublicKey(key: RsaKeyPair): Uint8Array {
  const rsaKey = encode(TAG.SEQUENCE, concat(
    encodeInteger(bytesToBigInt(base64urlToBytes(key.n))),
    encodeInteger(bytesToBigInt(base64urlToBytes(key.e)))
  ));
  return encode(TAG.SEQUENCE, concat(
    encode(TAG.SEQUENCE, concat(encodeOid(OID.rsaEncryption), encode(TAG.NULL, new Uint8Array(0)))),
    encodeBitString(rsaKey)
  ));
}

/**
 * 导出成 PKCS#1 的 `RSA PRIVATE KEY`。
 *
 * 结构完整（带 CRT 参数），openssl 读得懂，我们自己也解析得回来 ——
 * cert-manager 那边就是从 Secret 的 `tls.key` 里把 CA 的私钥读出来签下一级的，
 * 靠猜是猜不回来的。
 */
export function encodePrivateKeyPem(key: RsaKeyPair): string {
  const der = encode(TAG.SEQUENCE, concat(
    encodeInteger(0n),
    ...(['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] as const)
      .map((field) => encodeInteger(bytesToBigInt(base64urlToBytes(key[field]))))
  ));
  return toPem('RSA PRIVATE KEY', der);
}

/** 从 PEM 里把私钥读回来 */
export function parsePrivateKeyPem(pem: string): RsaKeyPair | undefined {
  const match = /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/.exec(pem);
  if (!match) return undefined;
  try {
    const der = base64ToBytes(match[1].replace(/\s+/g, ''));
    const root = parseDer(der);
    const values = root.children!.slice(1, 9).map((node) => bytesToBase64url(trimLeadingZeros(node.value)));
    const [n, e, d, p, q, dp, dq, qi] = values;
    return { n, e, d, p, q, dp, dq, qi };
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

export function parseCertificate(der: Uint8Array): Certificate {
  const root = parseDer(der);
  const tbs = root.children![0];
  const signature = root.children![2];

  let index = 0;
  const version = tbs.children![index].tag === 0xa0 ? tbs.children![index++] : undefined;
  void version;
  const serial = decodeInteger(tbs.children![index++]);
  index += 1;                                  // signature algorithm
  const issuer = decodeName(tbs.children![index++]);
  const validity = tbs.children![index++];
  const subject = decodeName(tbs.children![index++]);
  const publicKeyInfo = tbs.children![index++];
  const extensions = tbs.children!.slice(index).find((node) => node.tag === 0xa3);

  const parsed = decodeExtensions(extensions);
  return {
    der,
    pem: toPem('CERTIFICATE', der),
    subject,
    issuer,
    serial,
    notBefore: decodeUtcTime(validity.children![0]),
    notAfter: decodeUtcTime(validity.children![1]),
    dnsNames: parsed.dnsNames,
    ipAddresses: parsed.ipAddresses,
    isCa: parsed.isCa,
    pathLength: parsed.pathLength,
    usages: parsed.usages,
    publicKey: decodePublicKey(publicKeyInfo),
    // 验签时要用 tbs 的原始字节，重新编码可能和原文差一个字节
    ...({ tbsBytes: der.subarray(tbs.start, tbs.end), signatureBytes: signature.value.subarray(1) } as object),
  } as Certificate;
}

interface ParsedInternals {
  tbsBytes: Uint8Array;
  signatureBytes: Uint8Array;
}

function internals(certificate: Certificate): ParsedInternals {
  return certificate as unknown as ParsedInternals;
}

function decodeName(node: Asn1Node): { commonName: string; organization?: string } {
  const out: { commonName: string; organization?: string } = { commonName: '' };
  for (const rdnNode of node.children ?? []) {
    for (const pair of rdnNode.children ?? []) {
      const oid = decodeOid(pair.children![0]);
      const value = new TextDecoder().decode(pair.children![1].value);
      if (oid === OID.commonName) out.commonName = value;
      if (oid === OID.organization) out.organization = value;
    }
  }
  return out;
}

function decodePublicKey(node: Asn1Node): { n: string; e: string } {
  // BIT STRING 的第一个字节是「未使用位数」，跳过
  const inner = parseDer(node.children![1].value.subarray(1));
  return {
    n: bytesToBase64url(trimLeadingZeros(inner.children![0].value)),
    e: bytesToBase64url(trimLeadingZeros(inner.children![1].value)),
  };
}

/**
 * DER 的 INTEGER 在最高位是 1 时会补一个 0x00 表示正数。
 *
 * 不去掉的话模数会变成 257 字节，`verify` 里那句长度检查就永远不过 ——
 * 表现是「所有签名都验不过」，而签名本身其实是对的。
 */
function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

function decodeExtensions(node: Asn1Node | undefined): {
  dnsNames: string[];
  ipAddresses: string[];
  isCa: boolean;
  pathLength?: number;
  usages: string[];
} {
  const result = { dnsNames: [] as string[], ipAddresses: [] as string[], isCa: false, usages: [] as string[] } as {
    dnsNames: string[]; ipAddresses: string[]; isCa: boolean; pathLength?: number; usages: string[];
  };
  if (!node) return result;

  for (const extensionNode of node.children![0].children ?? []) {
    const oid = decodeOid(extensionNode.children![0]);
    const payload = extensionNode.children![extensionNode.children!.length - 1].value;
    const inner = payload.length > 0 ? parseDer(payload) : undefined;

    if (oid === OID.basicConstraints && inner) {
      const ca = inner.children?.find((child) => child.tag === TAG.BOOLEAN);
      result.isCa = Boolean(ca && ca.value[0] === 0xff);
      const pathLength = inner.children?.find((child) => child.tag === TAG.INTEGER);
      if (pathLength) result.pathLength = Number(decodeInteger(pathLength));
    }
    if (oid === OID.subjectAltName && inner) {
      for (const name of inner.children ?? []) {
        if (name.tag === 0x82) result.dnsNames.push(new TextDecoder().decode(name.value));
        if (name.tag === 0x87) result.ipAddresses.push(Array.from(name.value).join('.'));
      }
    }
    if (oid === OID.extKeyUsage && inner) {
      for (const usage of inner.children ?? []) {
        const value = decodeOid(usage);
        if (value === OID.serverAuth) result.usages.push('serverAuth');
        if (value === OID.clientAuth) result.usages.push('clientAuth');
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 验证                                                                */
/* ------------------------------------------------------------------ */

export interface VerifyOptions {
  /** 服务端发来的链：叶子在前，中间证书在后 */
  chain: Certificate[];
  /** 信任库里的根 */
  roots: Certificate[];
  /** 要访问的名字 */
  hostname?: string;
  /** 现在几点（虚拟墙钟） */
  now: number;
}

export interface VerifyResult {
  ok: boolean;
  /** 报错文本照抄 Go 的 crypto/x509，curl 与 kubectl 打出来的就是它 */
  error?: string;
  /** 验通了的完整链，从叶子到根 */
  path?: Certificate[];
}

export function verifyChain(options: VerifyOptions): VerifyResult {
  const [leaf, ...intermediates] = options.chain;
  if (!leaf) return { ok: false, error: 'x509: no certificate presented' };

  // 1. 有效期。先查这个，因为它是最常见也最容易看懂的一种。
  for (const certificate of options.chain) {
    if (options.now < certificate.notBefore) {
      return {
        ok: false,
        error: `x509: certificate has expired or is not yet valid: current time `
          + `${iso(options.now)} is before ${iso(certificate.notBefore)}`,
      };
    }
    if (options.now > certificate.notAfter) {
      return {
        ok: false,
        error: `x509: certificate has expired or is not yet valid: current time `
          + `${iso(options.now)} is after ${iso(certificate.notAfter)}`,
      };
    }
  }

  // 2. 沿着 issuer 一级级往上找，直到落到信任库里的某个根
  const path: Certificate[] = [leaf];
  let current = leaf;
  const pool = [...intermediates];

  for (let depth = 0; depth < 8; depth += 1) {
    const root = options.roots.find((candidate) => signedBy(current, candidate));
    if (root) {
      path.push(root);
      return finish(path, leaf, options);
    }
    const index = pool.findIndex((candidate) => signedBy(current, candidate));
    if (index < 0) {
      /**
       * 链断了。
       *
       * 最常见的原因是**服务端只发了叶子证书，没带中间证书** —— 浏览器里
       * 有时候能打开（因为它缓存过那张中间证书），curl 和服务之间的调用
       * 则一定失败。这是「我这儿好好的」这类问题的经典来源。
       */
      return { ok: false, error: 'x509: certificate signed by unknown authority' };
    }
    const [next] = pool.splice(index, 1);
    if (!next.isCa) {
      return { ok: false, error: `x509: certificate ${next.subject.commonName} is not a certificate authority` };
    }
    path.push(next);
    current = next;
  }
  return { ok: false, error: 'x509: certificate chain too long' };
}

function finish(path: Certificate[], leaf: Certificate, options: VerifyOptions): VerifyResult {
  if (!options.hostname) return { ok: true, path };
  if (matchesHostname(leaf, options.hostname)) return { ok: true, path };

  if (leaf.dnsNames.length === 0 && leaf.ipAddresses.length === 0) {
    /**
     * 一张 SAN 都没有。
     *
     * 2017 年之后所有主流验证器都不再看 CN 了，但很多内网 CA 的模板还停在
     * 那之前。报错要说清楚是这个原因，否则学员会盯着 CN 看半天。
     */
    return {
      ok: false,
      error: 'x509: certificate relies on legacy Common Name field, use SANs instead',
    };
  }
  const names = [...leaf.dnsNames, ...leaf.ipAddresses].join(', ');
  return { ok: false, error: `x509: certificate is valid for ${names}, not ${options.hostname}` };
}

/** child 是不是被 parent 签的：名字对得上，而且签名验得过 */
export function signedBy(child: Certificate, parent: Certificate): boolean {
  if (child.issuer.commonName !== parent.subject.commonName) return false;
  const { tbsBytes, signatureBytes } = internals(child);
  return verify(parent.publicKey, tbsBytes, signatureBytes);
}

/** SAN 匹配。通配只能占一整段，而且只能在最左边。 */
export function matchesHostname(certificate: Certificate, hostname: string): boolean {
  if (certificate.ipAddresses.includes(hostname)) return true;
  return certificate.dnsNames.some((name) => {
    if (name === hostname) return true;
    if (!name.startsWith('*.')) return false;
    const suffix = name.slice(1);
    if (!hostname.endsWith(suffix)) return false;
    const head = hostname.slice(0, hostname.length - suffix.length);
    // `*.corp.internal` 不匹配 `a.b.corp.internal`，也不匹配 `corp.internal`
    return head.length > 0 && !head.includes('.');
  });
}

/* ------------------------------------------------------------------ */

export function toPem(label: string, der: Uint8Array): string {
  const base64 = bytesToBase64(der);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function fromPem(pem: string): Uint8Array[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => {
    const base64 = block.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    return base64ToBytes(base64);
  });
}

/** 一个 PEM 里可能串着好几张证书（叶子 + 中间），按顺序解出来 */
export function parseChain(pem: string): Certificate[] {
  return fromPem(pem).map(parseCertificate);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result >>> 0;
}
