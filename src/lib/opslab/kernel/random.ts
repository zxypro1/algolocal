/**
 * 确定性随机数
 *
 * 模拟世界里任何「随机」都必须可复现：Pod 名字的后缀、调度器打平时的抖动、
 * 注入故障的时机。用种子化的 PRNG，并且把内部状态暴露出来 ——
 * 快照要连同随机数状态一起存，否则恢复之后的世界会走上另一条分支。
 */

export interface DeterministicRandom {
  /** [0, 1) */
  next(): number;
  /** [0, maxExclusive) 的整数 */
  int(maxExclusive: number): number;
  /** 从数组里挑一个；空数组返回 undefined */
  pick<T>(items: readonly T[]): T | undefined;
  /** 生成一个 k8s 风格的小写字母数字后缀，例如 `7f4x2` */
  suffix(length?: number): string;
  /** 当前内部状态，用于快照 */
  state(): number;
  /** 从快照恢复 */
  restore(state: number): void;
}

const SUFFIX_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

/**
 * mulberry32。选它是因为状态只有一个 32 位整数 ——
 * 快照里存一个数字就够，不用序列化一整个生成器。
 */
export function createRandom(seed: number): DeterministicRandom {
  let state = seed >>> 0 || 1;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    suffix(length = 5): string {
      let out = '';
      for (let i = 0; i < length; i += 1) {
        out += SUFFIX_ALPHABET[Math.floor(next() * SUFFIX_ALPHABET.length)];
      }
      return out;
    },
    state: () => state,
    restore(value: number) {
      state = value >>> 0 || 1;
    },
  };
}
