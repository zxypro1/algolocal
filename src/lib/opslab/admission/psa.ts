/**
 * Pod Security Admission
 *
 * PSP 在 1.25 已经删掉了，替代它的是 PSA：**三档预置标准，靠命名空间上的
 * 标签开启**，没有自定义规则。想要自定义就得上 Kyverno 那一类。
 *
 *   privileged  什么都不管
 *   baseline    挡住已知的提权途径（特权容器、hostPath、hostNetwork…）
 *   restricted  再加上强化要求（非 root、丢掉所有 capability、seccomp…）
 *
 * 三种模式各自独立：`enforce` 拦下来，`audit` 记日志，`warn` 回一条警告。
 * 只打 `warn` 标签而以为自己拦住了，是最常见的误会。
 */
import type { KubeObject } from '../apiserver';

export type PsaLevel = 'privileged' | 'baseline' | 'restricted';

export const PSA_LABELS = {
  enforce: 'pod-security.kubernetes.io/enforce',
  audit: 'pod-security.kubernetes.io/audit',
  warn: 'pod-security.kubernetes.io/warn',
} as const;

export interface PsaModes {
  enforce: PsaLevel;
  audit?: PsaLevel;
  warn?: PsaLevel;
}

export function modesOf(namespace: KubeObject | undefined): PsaModes {
  const labels = namespace?.metadata.labels ?? {};
  const level = (value: string | undefined): PsaLevel | undefined =>
    value === 'baseline' || value === 'restricted' || value === 'privileged' ? value : undefined;
  return {
    enforce: level(labels[PSA_LABELS.enforce]) ?? 'privileged',
    audit: level(labels[PSA_LABELS.audit]),
    warn: level(labels[PSA_LABELS.warn]),
  };
}

interface Container {
  name?: string;
  image?: string;
  securityContext?: Record<string, any>;
}

/**
 * 检查一个 Pod 的 spec。
 *
 * 返回的每一条都照抄真 PSA 的措辞 —— 那些话把「哪个容器、哪个字段、
 * 该设成什么」说全了，学员照着改就行，不用去翻文档。
 */
export function violationsOf(podSpec: any, level: PsaLevel): string[] {
  if (level === 'privileged') return [];
  const out: string[] = [];
  const containers: Container[] = [
    ...(podSpec?.containers ?? []),
    ...(podSpec?.initContainers ?? []),
    ...(podSpec?.ephemeralContainers ?? []),
  ];

  /* ---------------- baseline ---------------- */

  const privileged = containers.filter((container) => container.securityContext?.privileged === true);
  if (privileged.length > 0) {
    out.push(`privileged (${describe(privileged)} must not set securityContext.privileged=true)`);
  }
  if (podSpec?.hostNetwork === true || podSpec?.hostPID === true || podSpec?.hostIPC === true) {
    const set = [
      podSpec.hostNetwork === true && 'hostNetwork',
      podSpec.hostPID === true && 'hostPID',
      podSpec.hostIPC === true && 'hostIPC',
    ].filter(Boolean).join(', ');
    out.push(`host namespaces (${set}=true)`);
  }
  const hostPaths = (podSpec?.volumes ?? []).filter((volume: any) => volume.hostPath);
  if (hostPaths.length > 0) {
    out.push(`hostPath volumes (volume${hostPaths.length > 1 ? 's' : ''} `
      + `${hostPaths.map((volume: any) => `"${volume.name}"`).join(', ')})`);
  }
  const added = containers.filter((container) =>
    (container.securityContext?.capabilities?.add ?? [])
      .some((capability: string) => !BASELINE_CAPABILITIES.includes(capability)));
  if (added.length > 0) {
    out.push(`unrestricted capabilities (${describe(added)} must not include capabilities beyond the default set)`);
  }

  if (level === 'baseline') return out;

  /* ---------------- restricted ---------------- */

  const escalating = containers.filter(
    (container) => container.securityContext?.allowPrivilegeEscalation !== false
  );
  if (escalating.length > 0) {
    out.push(`allowPrivilegeEscalation != false (${describe(escalating)} `
      + 'must set securityContext.allowPrivilegeEscalation=false)');
  }

  const asRoot = containers.filter((container) =>
    container.securityContext?.runAsNonRoot !== true && podSpec?.securityContext?.runAsNonRoot !== true);
  if (asRoot.length > 0) {
    out.push(`runAsNonRoot != true (pod or ${describe(asRoot)} `
      + 'must set securityContext.runAsNonRoot=true)');
  }

  const keepsCapabilities = containers.filter((container) =>
    !(container.securityContext?.capabilities?.drop ?? []).includes('ALL'));
  if (keepsCapabilities.length > 0) {
    out.push(`unrestricted capabilities (${describe(keepsCapabilities)} `
      + 'must set securityContext.capabilities.drop=["ALL"])');
  }

  const seccomp = podSpec?.securityContext?.seccompProfile?.type;
  const badSeccomp = containers.filter((container) => {
    const type = container.securityContext?.seccompProfile?.type ?? seccomp;
    return type !== 'RuntimeDefault' && type !== 'Localhost';
  });
  if (badSeccomp.length > 0) {
    out.push('seccompProfile (pod or containers must set securityContext.seccompProfile.type '
      + 'to "RuntimeDefault" or "Localhost")');
  }

  return out;
}

/** baseline 允许保留的 capability，只有这一个 */
const BASELINE_CAPABILITIES = ['NET_BIND_SERVICE'];

function describe(containers: Container[]): string {
  const names = containers.map((container) => `"${container.name ?? '?'}"`);
  return `container${names.length > 1 ? 's' : ''} ${names.join(', ')}`;
}

/** 真 PSA 的拒绝消息 */
export function psaMessage(level: PsaLevel, violations: string[]): string {
  return `violates PodSecurity "${level}:latest": ${violations.join(', ')}`;
}
