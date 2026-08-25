/**
 * 真的签、真的验
 *
 * 第 9 关要教的是「看起来没问题但验不过」的四种，它们报的错完全不同：
 *
 *   unknown authority          中间证书没带全 / 自签的没进信任库
 *   certificate is valid for   SAN 里没有这个名字
 *   has expired                过期了
 *   legacy Common Name         只写了 CN 没写 SAN
 *
 * 能分清才谈得上会查，所以这一套用例逐条钉住报错文本。
 */
import {
  issueCertificate, matchesHostname, parseCertificate, parseChain, parsePrivateKeyPem,
  signedBy, sign, toPem, verify, verifyChain, KEY_POOL,
} from '../../src/lib/opslab/crypto';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-03-02T09:00:00Z');

function ca(commonName: string, options: { notBefore?: number; notAfter?: number } = {}) {
  return issueCertificate({
    commonName,
    organization: 'Corp',
    isCa: true,
    pathLength: 1,
    notBefore: options.notBefore ?? NOW - 365 * DAY,
    notAfter: options.notAfter ?? NOW + 365 * DAY,
  });
}

function leaf(
  commonName: string,
  issuer: ReturnType<typeof ca>,
  options: { dnsNames?: string[]; ipAddresses?: string[]; notBefore?: number; notAfter?: number } = {}
) {
  return issueCertificate({
    commonName,
    dnsNames: options.dnsNames,
    ipAddresses: options.ipAddresses,
    notBefore: options.notBefore ?? NOW - DAY,
    notAfter: options.notAfter ?? NOW + 90 * DAY,
  }, { certificate: issuer, key: issuer.key });
}

describe('RSA 签名', () => {
  it('验得过，改一个字节就验不过', () => {
    const key = KEY_POOL[0];
    const message = new TextEncoder().encode('hello');
    const signature = sign(key, message);
    expect(verify(key, message, signature)).toBe(true);
    expect(verify(key, new TextEncoder().encode('hellp'), signature)).toBe(false);
    expect(verify(KEY_POOL[1], message, signature)).toBe(false);
  });

  it('没有随机数，同样的输入签出同样的字节', () => {
    const key = KEY_POOL[2];
    const message = new TextEncoder().encode('deterministic');
    expect(Array.from(sign(key, message))).toEqual(Array.from(sign(key, message)));
  });
});

describe('证书的编解码', () => {
  it('签出来的证书自己解得开，字段都对', () => {
    const root = ca('Corp Root CA');
    const certificate = leaf('portal', root, { dnsNames: ['portal.corp.internal'] });

    expect(certificate.subject.commonName).toBe('portal');
    expect(certificate.issuer.commonName).toBe('Corp Root CA');
    expect(certificate.dnsNames).toEqual(['portal.corp.internal']);
    expect(certificate.isCa).toBe(false);
    expect(certificate.usages).toEqual(['serverAuth']);
    expect(certificate.notAfter - certificate.notBefore).toBe(91 * DAY);
  });

  it('CA 证书带 basicConstraints CA:TRUE 与 pathLen', () => {
    const root = ca('Corp Root CA');
    expect(root.isCa).toBe(true);
    expect(root.pathLength).toBe(1);
  });

  it('PEM 转一圈回来还是同一张', () => {
    const root = ca('Corp Root CA');
    const certificate = leaf('portal', root, { dnsNames: ['portal.corp.internal'] });
    expect(certificate.pem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);

    const [reparsed] = parseChain(certificate.pem);
    expect(Array.from(reparsed.der)).toEqual(Array.from(certificate.der));
    expect(reparsed.dnsNames).toEqual(['portal.corp.internal']);
  });

  it('一个 PEM 里串着叶子 + 中间证书，按顺序解出来', () => {
    const root = ca('Corp Root CA');
    const intermediate = issueCertificate({
      commonName: 'Corp Issuing CA', isCa: true, pathLength: 0,
      notBefore: NOW - 180 * DAY, notAfter: NOW + 180 * DAY,
    }, { certificate: root, key: root.key });
    const certificate = leaf('portal', intermediate as never, { dnsNames: ['portal.corp.internal'] });

    const bundle = certificate.pem + intermediate.pem;
    const chain = parseChain(bundle);
    expect(chain.map((item) => item.subject.commonName)).toEqual(['portal', 'Corp Issuing CA']);
  });

  it('IP 也能进 SAN', () => {
    const root = ca('Corp Root CA');
    const certificate = leaf('node', root, { ipAddresses: ['10.10.8.20'] });
    expect(certificate.ipAddresses).toEqual(['10.10.8.20']);
  });

  it('同样的输入签出同样的证书 —— 重放才可能逐字节一致', () => {
    const a = leaf('portal', ca('Corp Root CA'), { dnsNames: ['portal.corp.internal'] });
    const b = leaf('portal', ca('Corp Root CA'), { dnsNames: ['portal.corp.internal'] });
    expect(Array.from(a.der)).toEqual(Array.from(b.der));
  });
});

describe('私钥导出与读回', () => {
  it('导出的是结构完整的 PKCS#1，能原样读回来', () => {
    const root = ca('Corp Root CA');
    expect(root.privateKeyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);

    const back = parsePrivateKeyPem(root.privateKeyPem);
    expect(back).toEqual(root.key);
  });

  it('读回来的私钥签出来的东西，用证书里的公钥验得过', () => {
    const root = ca('Corp Root CA');
    const back = parsePrivateKeyPem(root.privateKeyPem)!;
    const message = new TextEncoder().encode('signed with the reloaded key');
    expect(verify(root.publicKey, message, sign(back, message))).toBe(true);
  });

  it('不是私钥的 PEM 读回来是 undefined，不抛', () => {
    expect(parsePrivateKeyPem('not a pem')).toBeUndefined();
    expect(parsePrivateKeyPem(ca('X').pem)).toBeUndefined();
  });
});

describe('链验证', () => {
  const root = ca('Corp Root CA');
  const intermediate = issueCertificate({
    commonName: 'Corp Issuing CA', isCa: true, pathLength: 0,
    notBefore: NOW - 180 * DAY, notAfter: NOW + 180 * DAY,
  }, { certificate: root, key: root.key });
  const server = issueCertificate({
    commonName: 'portal', dnsNames: ['portal.corp.internal'],
    notBefore: NOW - DAY, notAfter: NOW + 90 * DAY,
  }, { certificate: intermediate, key: intermediate.key });

  it('签名关系是真的', () => {
    expect(signedBy(server, intermediate)).toBe(true);
    expect(signedBy(intermediate, root)).toBe(true);
    expect(signedBy(server, root)).toBe(false);
  });

  it('带全了中间证书就验得过', () => {
    const result = verifyChain({
      chain: [server, intermediate], roots: [root],
      hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.path!.map((item) => item.subject.commonName))
      .toEqual(['portal', 'Corp Issuing CA', 'Corp Root CA']);
  });

  it('中间证书没带全 -> unknown authority（第 9 关埋的就是这个坑）', () => {
    const result = verifyChain({
      chain: [server], roots: [root], hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('x509: certificate signed by unknown authority');
  });

  it('根不在信任库里 -> 同样是 unknown authority', () => {
    const other = ca('Someone Else CA');
    const result = verifyChain({
      chain: [server, intermediate], roots: [other],
      hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('x509: certificate signed by unknown authority');
  });

  it('过期了，报错里带上时间', () => {
    const expired = issueCertificate({
      commonName: 'portal', dnsNames: ['portal.corp.internal'],
      notBefore: NOW - 400 * DAY, notAfter: NOW - 10 * DAY,
    }, { certificate: intermediate, key: intermediate.key });

    const result = verifyChain({
      chain: [expired, intermediate], roots: [root],
      hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('x509: certificate has expired or is not yet valid');
    expect(result.error).toContain('is after');
  });

  it('还没生效', () => {
    const future = issueCertificate({
      commonName: 'portal', dnsNames: ['portal.corp.internal'],
      notBefore: NOW + 10 * DAY, notAfter: NOW + 100 * DAY,
    }, { certificate: intermediate, key: intermediate.key });
    const result = verifyChain({
      chain: [future, intermediate], roots: [root], hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.error).toContain('is before');
  });

  it('SAN 里没有这个名字', () => {
    const result = verifyChain({
      chain: [server, intermediate], roots: [root],
      hostname: 'admin.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('x509: certificate is valid for portal.corp.internal, not admin.corp.internal');
  });

  it('只写了 CN 没写 SAN —— 报错要说清楚是这个原因', () => {
    const legacy = issueCertificate({
      commonName: 'portal.corp.internal',
      notBefore: NOW - DAY, notAfter: NOW + 90 * DAY,
    }, { certificate: intermediate, key: intermediate.key });

    const result = verifyChain({
      chain: [legacy, intermediate], roots: [root],
      hostname: 'portal.corp.internal', now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('x509: certificate relies on legacy Common Name field, use SANs instead');
  });

  it('不检查名字时只验链', () => {
    expect(verifyChain({ chain: [server, intermediate], roots: [root], now: NOW }).ok).toBe(true);
  });
});

describe('SAN 通配', () => {
  const root = ca('Corp Root CA');
  const wildcard = leaf('wild', root, { dnsNames: ['*.corp.internal'] });

  it.each([
    ['portal.corp.internal', true],
    ['api.corp.internal', true],
    // 通配只占一整段，也只在最左边
    ['a.b.corp.internal', false],
    ['corp.internal', false],
    ['portal.corp.internal.evil.com', false],
  ])('*.corp.internal 匹配 %s -> %s', (hostname, expected) => {
    expect(matchesHostname(wildcard, hostname)).toBe(expected);
  });
});
