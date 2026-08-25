/**
 * 把 PSA 接到 apiserver 上
 *
 * PSA 只看 **Pod**。给 Deployment 打的标签不会拦住 Deployment 本身 ——
 * 它照样被收下，然后 ReplicaSet 控制器去建 Pod 的时候被拦，于是
 * `kubectl get deploy` 显示 0/3，而错误藏在 ReplicaSet 的事件里。
 * 这是真集群里的行为，也是这一层最容易困住人的地方。
 */
import type { KubeObject, Validator } from '../apiserver';
import { modesOf, psaMessage, violationsOf } from './psa';

export interface PsaOptions {
  /** 按名字取命名空间对象 —— 标签写在它上面 */
  namespace(name: string): KubeObject | undefined;
}

export function createPsaValidator(options: PsaOptions): Validator {
  return {
    name: 'PodSecurity',
    review({ definition, namespace, object }) {
      if (definition.group !== '' || definition.resource !== 'pods') return undefined;
      if (!namespace) return undefined;
      const modes = modesOf(options.namespace(namespace));
      if (modes.enforce === 'privileged') return undefined;
      const violations = violationsOf((object.spec ?? {}) as any, modes.enforce);
      if (violations.length === 0) return undefined;
      return psaMessage(modes.enforce, violations);
    },
  };
}
