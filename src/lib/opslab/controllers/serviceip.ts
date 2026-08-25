/**
 * ClusterIP 分配
 *
 * 真集群里这件事发生在 apiserver 里，不是某个控制器事后补的 —— 所以
 * `kubectl expose` 之后紧接着 `kubectl get svc`，IP 已经在那儿了。
 * 我们也放在同一层（Registry 的 defaulter），行为才对得上。
 *
 * 三种 Service 不分配：
 *  - `clusterIP: None`（headless，DNS 直接回后端 Pod 的地址）
 *  - `type: ExternalName`（就是个 CNAME）
 *  - 已经写死了 IP 的（关卡里手写的对象）
 */
import type { Defaulter, KubeObject, Registry, ResourceDefinition, Scheme } from '../apiserver';

/** k8s 默认的 service CIDR */
export const DEFAULT_SERVICE_CIDR = '10.96.0.0/12';

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value >>> 0;
}

function parseCidr(cidr: string): { base: number; size: number } {
  const [address, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const octets = address.split('.').map(Number);
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = 2 ** (32 - bits);
  return { base: (value & (size === 4294967296 ? 0 : ~(size - 1))) >>> 0, size };
}

function formatIp(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

export interface ServiceIpOptions {
  registry: Registry;
  scheme: Scheme;
  cidr?: string;
}

/**
 * 名字决定 IP，冲突就线性往后探。
 *
 * 不用计数器是因为要可复现：同一个世界重放两遍，同一个 Service 必须拿到
 * 同一个 IP，哪怕中间创建顺序被别的东西影响过。
 */
export function createServiceIpDefaulter(options: ServiceIpOptions): Defaulter {
  const { base, size } = parseCidr(options.cidr ?? DEFAULT_SERVICE_CIDR);
  // .0 是网络地址，.1 留给 kubernetes 这个 Service，最后一个也不用，
  // 所以可分的是 [base+2, base+size-2]
  const usable = size - 3;

  const taken = (): Set<string> => {
    const definition = options.scheme.get({ group: '', version: 'v1', resource: 'services' });
    if (!definition) return new Set();
    const used = new Set<string>();
    for (const service of options.registry.list(definition).items) {
      const ip = ((service.spec ?? {}) as { clusterIP?: string }).clusterIP;
      if (ip && ip !== 'None') used.add(ip);
    }
    return used;
  };

  return {
    matches: (definition: ResourceDefinition) =>
      definition.group === '' && definition.resource === 'services',

    apply(object: KubeObject, _definition, existing?: KubeObject) {
      const spec = (object.spec ?? (object.spec = {})) as {
        clusterIP?: string; clusterIPs?: string[]; type?: string;
      };
      if (spec.type === 'ExternalName') return;

      // ClusterIP 是不可变字段：整体替换时没写就沿用旧的，
      // 不然 `kubectl replace -f` 会让一个在用的 Service 换掉 VIP
      if (!spec.clusterIP && existing) {
        const previous = ((existing.spec ?? {}) as { clusterIP?: string }).clusterIP;
        if (previous) {
          spec.clusterIP = previous;
          spec.clusterIPs = previous === 'None' ? undefined : [previous];
          return;
        }
      }
      if (spec.clusterIP === 'None') {
        spec.clusterIPs = ['None'];
        return;
      }
      if (spec.clusterIP) {
        spec.clusterIPs = spec.clusterIPs ?? [spec.clusterIP];
        return;
      }

      const used = taken();
      const seed = hash(`${object.metadata.namespace ?? ''}/${object.metadata.name ?? ''}`);
      for (let probe = 0; probe < usable; probe += 1) {
        const candidate = formatIp((base + 2 + ((seed + probe) % usable)) >>> 0);
        if (!used.has(candidate)) {
          spec.clusterIP = candidate;
          spec.clusterIPs = [candidate];
          return;
        }
      }
      // CIDR 满了。真 apiserver 报的是 InternalError，实验里到不了这一步。
    },
  };
}
