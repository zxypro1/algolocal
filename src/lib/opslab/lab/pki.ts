/**
 * 把题目声明的 PKI 变成真证书
 *
 * 题目里只写「有哪些 CA、谁签谁、哪张故意做坏了」，密钥与 DER 在这里用真 RSA
 * 生成。于是「中间证书没带全」这种坑是**真的坑** —— 验证器真的会拒绝，
 * 而不是我们编一个错误码出来。
 */
import type { OpsPkiSpec } from '../../engineering/types';
import type { KubeObject } from '../apiserver';
import { issueCertificate, parseChain, type Certificate, type RsaKeyPair } from '../crypto';

const DAY = 24 * 60 * 60 * 1000;

export interface MaterializedPki {
  /** 要塞进集群的 Secret */
  secrets: KubeObject[];
  /** 装进跳板机信任库的 PEM */
  trustBundle: string;
}

export function materializePki(spec: OpsPkiSpec | undefined, now: number): MaterializedPki {
  if (!spec) return { secrets: [], trustBundle: '' };

  const authorities = new Map<string, { certificate: Certificate; key: RsaKeyPair; chainPem: string; rootPem: string }>();
  const secrets: KubeObject[] = [];

  for (const root of spec.roots ?? []) {
    const issued = issueCertificate({
      commonName: root.commonName,
      organization: 'Corp',
      isCa: true,
      pathLength: 2,
      notBefore: now - 365 * DAY,
      notAfter: now + (root.days ?? 3650) * DAY,
    });
    authorities.set(root.name, {
      certificate: issued, key: issued.key, chainPem: issued.pem, rootPem: issued.pem,
    });
    secrets.push(tlsSecret(root.name, root.namespace, {
      'tls.crt': issued.pem, 'tls.key': issued.privateKeyPem, 'ca.crt': issued.pem,
    }));
  }

  for (const middle of spec.intermediates ?? []) {
    const parent = authorities.get(middle.signedBy);
    if (!parent) throw new Error(`PKI: 找不到签发者 ${middle.signedBy}`);
    const issued = issueCertificate({
      commonName: middle.commonName,
      organization: 'Corp',
      isCa: true,
      pathLength: 0,
      notBefore: now - 180 * DAY,
      notAfter: now + (middle.days ?? 1825) * DAY,
    }, { certificate: parent.certificate, key: parent.key });

    authorities.set(middle.name, {
      certificate: issued,
      key: issued.key,
      // 中间 CA 的 tls.crt 里只有它自己；根在 ca.crt。cert-manager 签叶子时
      // 会把这一段接在叶子后面，于是链是完整的。
      chainPem: issued.pem,
      rootPem: parent.rootPem,
    });
    secrets.push(tlsSecret(middle.name, middle.namespace, {
      'tls.crt': issued.pem, 'tls.key': issued.privateKeyPem, 'ca.crt': parent.rootPem,
    }));
  }

  for (const server of spec.serverCertificates ?? []) {
    const issuer = authorities.get(server.signedBy);
    if (!issuer) throw new Error(`PKI: 找不到签发者 ${server.signedBy}`);

    const expired = server.expiredDaysAgo !== undefined;
    const notBefore = expired ? now - (server.expiredDaysAgo! + 365) * DAY : now - DAY;
    const notAfter = expired ? now - server.expiredDaysAgo! * DAY : now + (server.days ?? 90) * DAY;

    const issued = issueCertificate({
      commonName: server.commonName,
      dnsNames: server.dnsNames ?? [server.commonName],
      notBefore,
      notAfter,
      usages: ['serverAuth'],
    }, { certificate: issuer.certificate, key: issuer.key });

    secrets.push(tlsSecret(server.name, server.namespace, {
      // leafOnly 就是那个坑：只放叶子，不接签发链
      'tls.crt': server.leafOnly ? issued.pem : issued.pem + issuer.chainPem,
      'tls.key': issued.privateKeyPem,
      'ca.crt': issuer.rootPem,
    }));
  }

  const trustBundle = (spec.trust ?? [])
    .map((name) => authorities.get(name)?.rootPem ?? '')
    .join('');

  return { secrets, trustBundle };
}

/** 从一堆 PEM 里挑出根，给信任库用 */
export function rootsOf(pem: string): Certificate[] {
  return parseChain(pem).filter((certificate) => certificate.isCa);
}

function tlsSecret(name: string, namespace: string, data: Record<string, string>): KubeObject {
  return {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name, namespace },
    type: 'kubernetes.io/tls',
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, btoa(value)])),
  } as unknown as KubeObject;
}
