/**
 * 宿主侧的容器：vec / map / ring
 *
 * ## 为什么由平台实现，而不是让学员用 C 写
 *
 * 这个 C 子集里没有 `struct`，也没有宿主堆 —— 加上它们要付出的代价
 * （结构体布局、成员访问、`malloc` 的分配器、指针别名分析）不小，
 * 而这些关卡真正要教的是**分页 KV cache 的块表怎么管、连续批处理的
 * 请求队列怎么调度**，不是怎么用裸指针搓一个动态数组。
 *
 * 真实工程里这三样东西也从来不是自己写的：vLLM 的块表是 Python 的
 * dict 与 list，TensorRT-LLM 是 STL。所以「平台给容器」不是简化，
 * 是把抽象层次摆到和真实工程一致的位置。
 *
 * ## 句柄而不是指针
 *
 * 每个容器返回一个 `int` 句柄。这样学员那边只有整数，不需要指针语义，
 * 也不可能拿一个悬空指针去解引用。句柄从 1 开始 —— 0 留给「无效句柄」，
 * 这样忘了初始化的变量（C 里是 0）会立刻炸，而不是悄悄操作 0 号容器。
 */

export class HostRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostRuntimeError';
  }
}

/** 一个开放寻址的 int64 → int32 映射 */
class IntMap {
  private keys: Float64Array;
  private values: Int32Array;
  /** 0 空，1 占用，2 已删（墓碑） */
  private state: Uint8Array;
  private mask: number;
  private used = 0;
  private live = 0;

  constructor(capacity = 16) {
    const size = nextPowerOfTwo(Math.max(8, capacity));
    this.keys = new Float64Array(size);
    this.values = new Int32Array(size);
    this.state = new Uint8Array(size);
    this.mask = size - 1;
  }

  get size(): number {
    return this.live;
  }

  set(key: number, value: number): void {
    // 装载因子超过 0.7 就翻倍。墓碑也算进 used —— 只算 live 的话，
    // 「插入删除交替」会把表填满墓碑而永远不触发扩容，退化成线性扫描。
    if ((this.used + 1) * 10 > this.keys.length * 7) this.rehash();
    let index = this.hash(key);
    let firstTomb = -1;
    for (;;) {
      const state = this.state[index];
      if (state === 0) {
        const slot = firstTomb >= 0 ? firstTomb : index;
        if (firstTomb < 0) this.used += 1;
        this.state[slot] = 1;
        this.keys[slot] = key;
        this.values[slot] = value;
        this.live += 1;
        return;
      }
      if (state === 2 && firstTomb < 0) firstTomb = index;
      if (state === 1 && this.keys[index] === key) {
        this.values[index] = value;
        return;
      }
      index = (index + 1) & this.mask;
    }
  }

  find(key: number): number {
    let index = this.hash(key);
    for (;;) {
      const state = this.state[index];
      if (state === 0) return -1;
      if (state === 1 && this.keys[index] === key) return index;
      index = (index + 1) & this.mask;
    }
  }

  get(key: number, fallback: number): number {
    const at = this.find(key);
    return at < 0 ? fallback : this.values[at];
  }

  has(key: number): boolean {
    return this.find(key) >= 0;
  }

  delete(key: number): void {
    const at = this.find(key);
    if (at < 0) return;
    this.state[at] = 2;
    this.live -= 1;
  }

  private hash(key: number): number {
    // 键可能是拼出来的（比如 seqId * 4096 + blockIndex），低位规律性很强，
    // 直接取模会让所有键挤在少数几个槽里。先搅一下再取低位。
    let h = Math.trunc(key) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) & this.mask;
  }

  private rehash(): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const oldState = this.state;
    const size = this.keys.length * 2;
    this.keys = new Float64Array(size);
    this.values = new Int32Array(size);
    this.state = new Uint8Array(size);
    this.mask = size - 1;
    this.used = 0;
    this.live = 0;
    for (let i = 0; i < oldState.length; i += 1) {
      if (oldState[i] === 1) this.set(oldKeys[i], oldValues[i]);
    }
  }
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/** 三种容器的存放处，一个宿主程序一份 */
export class ContainerStore {
  private vecs: number[][] = [];
  private maps: IntMap[] = [];
  private rings: number[][] = [];

  /**
   * 每种容器的个数上限。
   *
   * 有上限是因为句柄泄漏在这里是**静默的**：容器不会被回收，
   * 一个写在循环里的 `vec_new()` 会一直涨到内存耗尽。撞上限时报错
   * 能把「你在循环里反复新建容器」这件事直接说出来。
   */
  private static readonly MAX = 4096;

  vecNew(): number {
    if (this.vecs.length >= ContainerStore.MAX) {
      throw new HostRuntimeError(`vec 的个数超过了 ${ContainerStore.MAX} —— 是不是在循环里反复 vec_new()？`);
    }
    this.vecs.push([]);
    return this.vecs.length;
  }

  mapNew(): number {
    if (this.maps.length >= ContainerStore.MAX) {
      throw new HostRuntimeError(`map 的个数超过了 ${ContainerStore.MAX} —— 是不是在循环里反复 map_new()？`);
    }
    this.maps.push(new IntMap());
    return this.maps.length;
  }

  ringNew(): number {
    if (this.rings.length >= ContainerStore.MAX) {
      throw new HostRuntimeError(`ring 的个数超过了 ${ContainerStore.MAX} —— 是不是在循环里反复 ring_new()？`);
    }
    this.rings.push([]);
    return this.rings.length;
  }

  vec(handle: number): number[] {
    const found = this.vecs[handle - 1];
    if (!found) {
      throw new HostRuntimeError(
        handle === 0
          ? 'vec 句柄是 0 —— 变量还没用 vec_new() 初始化'
          : `没有编号 ${handle} 的 vec`
      );
    }
    return found;
  }

  map(handle: number): IntMap {
    const found = this.maps[handle - 1];
    if (!found) {
      throw new HostRuntimeError(
        handle === 0
          ? 'map 句柄是 0 —— 变量还没用 map_new() 初始化'
          : `没有编号 ${handle} 的 map`
      );
    }
    return found;
  }

  ring(handle: number): number[] {
    const found = this.rings[handle - 1];
    if (!found) {
      throw new HostRuntimeError(
        handle === 0
          ? 'ring 句柄是 0 —— 变量还没用 ring_new() 初始化'
          : `没有编号 ${handle} 的 ring`
      );
    }
    return found;
  }

  /** 越界读写在 C 里是未定义行为，这里明确报错 —— 模拟器最怕「看起来跑了」 */
  checkIndex(list: number[], index: number, what: string): void {
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new HostRuntimeError(
        `${what} 下标 ${index} 越界 —— 长度是 ${list.length}`
      );
    }
  }
}
