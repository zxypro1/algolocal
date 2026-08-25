/**
 * cert-manager
 *
 * 和 Envoy Gateway 一样，它自己是**集群里的一个工作负载**：卸载掉就不再签发，
 * Certificate 停在 Ready=Unknown。
 *
 * 签出来的东西是真的：真 RSA 签名、真 DER、真链。学员把 Secret 里的 tls.crt
 * 掏出来喂 `openssl x509 -text` 也读得懂，拿去验链更是真的会通过或失败。
 */
import type { KubeObject, ResourceDefinition } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isConflict, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, SECRETS } from '../controllers/resources';
import { issueCertificate, parseChain, toPem, type Certificate, type RsaKeyPair } from '../crypto';
import { keyFor } from '../crypto';
import { CERTIFICATES, CLUSTERISSUERS, ISSUERS } from './resources';

export const CERT_MANAGER_LABEL = { key: 'app.kubernetes.io/name', value: 'cert-manager' };

const DAY = 24 * 60 * 60 * 1000;

export class CertManagerController extends Controller {
  private certificates: Informer;
  private issuers: Informer;
  private clusterIssuers: Informer;
  private secrets: Informer;
  private deployments: Informer;

  constructor(context: ControllerContext) {
    super(context, 'cert-manager');
    this.certificates = new Informer(this.registry, CERTIFICATES);
    this.issuers = this.track(new Informer(this.registry, ISSUERS));
    this.clusterIssuers = this.track(new Informer(this.registry, CLUSTERISSUERS));
    this.secrets = this.track(new Informer(this.registry, SECRETS));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));

    this.watch(this.certificates);
    for (const informer of [this.issuers, this.clusterIssuers, this.deployments]) {
      informer.onChange(() => {
        for (const certificate of this.certificates.list()) this.queue.add(objectKey(certificate));
      });
    }
  }

  /** 控制器自己在不在。不在就什么都不签。 */
  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[CERT_MANAGER_LABEL.key] !== CERT_MANAGER_LABEL.value) return false;
      return (((deployment.status ?? {}) as any).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let request: KubeObject;
    try {
      request = this.registry.get(CERTIFICATES, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (request.metadata.deletionTimestamp) return;

    if (!this.installed()) {
      this.setStatus(request, 'Unknown', 'Pending', 'Waiting for cert-manager');
      return;
    }

    const spec = (request.spec ?? {}) as any;
    const issuer = this.resolveIssuer(request);
    if (!issuer) {
      this.setStatus(
        request, 'False', 'IssuerNotFound',
        `issuer.cert-manager.io "${spec.issuerRef?.name}" not found`
      );
      return;
    }

    const authority = this.authorityOf(issuer);
    if (!authority) {
      this.setStatus(
        request, 'False', 'SecretMissing',
        `Secret "${((issuer.spec ?? {}) as any).ca?.secretName}" not found`
      );
      return;
    }

    const dnsNames: string[] = spec.dnsNames ?? [];
    if (dnsNames.length === 0 && !spec.commonName) {
      this.setStatus(request, 'False', 'InvalidRequest', 'spec.dnsNames or spec.commonName is required');
      return;
    }

    const durationMs = parseDuration(spec.duration) ?? 90 * DAY;
    const notBefore = this.context.now();
    const leaf = issueCertificate({
      commonName: spec.commonName ?? dnsNames[0],
      dnsNames,
      ipAddresses: spec.ipAddresses,
      notBefore,
      notAfter: notBefore + durationMs,
      usages: spec.isCA ? undefined : ['serverAuth'],
      isCa: Boolean(spec.isCA),
    }, { certificate: authority.certificate, key: authority.key });

    /**
     * `tls.crt` 里放的是**叶子 + 中间证书**，不含根。
     *
     * 这是链条完整性的来源：cert-manager 会把 issuer 的链一起带上，
     * 手工造证书的人往往只放一张叶子 —— 第 9 关埋的正是这个坑。
     */
    const bundle = leaf.pem + authority.chainPem;
    this.writeSecret(request, spec.secretName ?? `${name}-tls`, {
      'tls.crt': bundle,
      'tls.key': leaf.privateKeyPem,
      'ca.crt': authority.rootPem,
    });
    this.setStatus(request, 'True', 'Ready', 'Certificate is up to date and has not expired', {
      notBefore: iso(leaf.notBefore),
      notAfter: iso(leaf.notAfter),
      renewalTime: iso(leaf.notAfter - (parseDuration(spec.renewBefore) ?? 30 * DAY)),
    });
  }

  private resolveIssuer(request: KubeObject): KubeObject | undefined {
    const ref = ((request.spec ?? {}) as any).issuerRef ?? {};
    if (ref.kind === 'ClusterIssuer') {
      return this.clusterIssuers.list().find((item) => item.metadata.name === ref.name);
    }
    return this.issuers.list().find(
      (item) => item.metadata.namespace === request.metadata.namespace && item.metadata.name === ref.name
    );
  }

  /**
   * issuer 背后那把 CA。
   *
   * 只支持 `spec.ca.secretName` 这一种（内网 PKI 的常见形态）。ACME 那条路
   * 需要真的走 HTTP-01 挑战，不在这一期。
   */
  private authorityOf(issuer: KubeObject): {
    certificate: Certificate;
    key: RsaKeyPair;
    chainPem: string;
    rootPem: string;
  } | undefined {
    const secretName = ((issuer.spec ?? {}) as any).ca?.secretName;
    if (!secretName) return undefined;
    const namespace = issuer.kind === 'ClusterIssuer'
      ? 'cert-manager'
      : issuer.metadata.namespace ?? 'default';

    const secret = this.secrets.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === secretName
    );
    if (!secret) return undefined;

    const data = decodeSecret(secret);
    const chain = parseChain(data['tls.crt'] ?? '');
    if (chain.length === 0) return undefined;

    return {
      certificate: chain[0],
      // CA 的私钥按它自己的名字取，和签发时用的是同一把
      key: keyFor(`${chain[0].subject.commonName}|${chain[0].notBefore}`),
      chainPem: data['tls.crt'] ?? '',
      rootPem: data['ca.crt'] ?? chain[chain.length - 1].pem,
    };
  }

  private writeSecret(owner: KubeObject, name: string, data: Record<string, string>): void {
    const namespace = owner.metadata.namespace ?? 'default';
    const encoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, btoa(value)]));
    const desired = {
      apiVersion: 'v1', kind: 'Secret',
      metadata: {
        name, namespace,
        annotations: { 'cert-manager.io/certificate-name': owner.metadata.name },
        ownerReferences: [{
          apiVersion: 'cert-manager.io/v1', kind: 'Certificate',
          name: owner.metadata.name, uid: owner.metadata.uid, controller: true,
        }],
      },
      type: 'kubernetes.io/tls',
      data: encoded,
    } as unknown as KubeObject;

    const existing = this.secrets.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === name
    );
    try {
      if (!existing) { this.registry.create(SECRETS, namespace, desired); return; }
      if (JSON.stringify((existing as any).data) === JSON.stringify(encoded)) return;
      this.registry.update(SECRETS, namespace, name, { ...existing, ...desired });
    } catch (error) {
      if (!isConflict(error) && !isNotFound(error)) throw error;
    }
  }

  private setStatus(
    request: KubeObject,
    ready: string,
    reason: string,
    message: string,
    extra: Record<string, string> = {}
  ): void {
    const status = {
      ...extra,
      conditions: [{
        type: 'Ready', status: ready, reason, message,
        lastTransitionTime: iso(this.context.now()),
        observedGeneration: request.metadata.generation ?? 1,
      }],
    };
    if (JSON.stringify(request.status ?? null) === JSON.stringify(status)) return;
    try {
      const latest = this.registry.get(
        CERTIFICATES, request.metadata.namespace, request.metadata.name
      );
      if (JSON.stringify(latest.status ?? null) === JSON.stringify(status)) return;
      this.registry.updateStatus(
        CERTIFICATES, request.metadata.namespace, request.metadata.name, { ...latest, status }
      );
    } catch (error) {
      if (!isConflict(error) && !isNotFound(error)) throw error;
    }
  }
}

/* ------------------------------------------------------------------ */

/** `2160h` / `90d` / `24h` */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)(h|m|s|d)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return amount * (unit ?? 0);
}

export function decodeSecret(secret: KubeObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(((secret as any).data ?? {}) as Record<string, string>)) {
    try { out[key] = atob(value); } catch { out[key] = ''; }
  }
  for (const [key, value] of Object.entries(((secret as any).stringData ?? {}) as Record<string, string>)) {
    out[key] = value;
  }
  return out;
}

/** 造一个根 CA 的 Secret，世界的初态用得着 */
export function caSecret(input: {
  name: string;
  namespace: string;
  commonName: string;
  notBefore: number;
  notAfter: number;
}): KubeObject {
  const root = issueCertificate({
    commonName: input.commonName,
    organization: 'Corp',
    isCa: true,
    pathLength: 1,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
  });
  return {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: input.name, namespace: input.namespace },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': btoa(root.pem),
      'tls.key': btoa(root.privateKeyPem),
      'ca.crt': btoa(root.pem),
    },
  } as unknown as KubeObject;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export { toPem };
