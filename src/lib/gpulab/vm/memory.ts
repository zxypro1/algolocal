/**
 * 内存与访存计量
 *
 * 这个文件是整个项目的判定地基。design/gpulab.md 里立的规矩是
 * **门槛只建立在结构性计量上** —— 而结构性计量几乎全部在这里产生：
 * 一次 warp 访存打到多少个 32B 扇区、共享内存有几路 bank 冲突。
 *
 * 这两个数不是估的，是按真硬件的规则一条条数出来的，
 * 所以它们换到真卡上一个不差。也正因如此，这里的规则必须写对。
 */

/** 全局访存的最小传输单位。ncu 的 dram__bytes 就是扇区数 × 32。 */
export const SECTOR_BYTES = 32;

/** 共享内存有 32 个 bank，每个 bank 4 字节宽 —— bank 号 = (字节地址 / 4) % 32 */
export const SHARED_BANKS = 32;

export const WARP_SIZE = 32;

export class MemoryFault extends Error {
  address: number;
  size: number;
  space: 'global' | 'shared' | 'local';
  constructor(space: 'global' | 'shared' | 'local', address: number, size: number, limit: number) {
    super(
      `invalid __${space}__ ${size === 4 ? 'read/write' : 'access'} of size ${size} bytes ` +
      `at 0x${(address >>> 0).toString(16)} —— 越界了（这块空间只有 ${limit} 字节）`
    );
    this.name = 'MemoryFault';
    this.address = address;
    this.size = size;
    this.space = space;
  }
}

/**
 * 一块线性内存。
 *
 * 地址就是字节偏移，从 1 开始分配 —— 0 留给空指针，这样解引用空指针
 * 会真的报越界，而不是悄悄读到第一个变量。
 */
export class LinearMemory {
  readonly bytes: ArrayBuffer;
  private readonly i32: Int32Array;
  private readonly u32: Uint32Array;
  private readonly f32: Float32Array;
  private cursor = 16;

  constructor(readonly capacity: number, private readonly space: 'global' | 'shared' | 'local') {
    this.bytes = new ArrayBuffer(capacity);
    this.i32 = new Int32Array(this.bytes);
    this.u32 = new Uint32Array(this.bytes);
    this.f32 = new Float32Array(this.bytes);
  }

  /** 分配一段，返回起始地址。按 256 字节对齐 —— 真 cudaMalloc 也是这样。 */
  allocate(bytes: number): number {
    const aligned = Math.ceil(this.cursor / 256) * 256;
    if (aligned + bytes > this.capacity) {
      throw new Error(
        `out of memory：想要 ${bytes} 字节，只剩 ${this.capacity - aligned} 字节`
      );
    }
    this.cursor = aligned + bytes;
    return aligned;
  }

  get used(): number {
    return this.cursor;
  }

  reset(): void {
    this.cursor = 16;
    new Uint8Array(this.bytes).fill(0);
  }

  private check(address: number, size: number): void {
    if (address < 0 || address + size > this.capacity || (address & 3) !== 0) {
      throw new MemoryFault(this.space, address, size, this.capacity);
    }
  }

  readI32(address: number): number {
    this.check(address, 4);
    return this.i32[address >> 2];
  }

  readU32(address: number): number {
    this.check(address, 4);
    return this.u32[address >> 2];
  }

  readF32(address: number): number {
    this.check(address, 4);
    return this.f32[address >> 2];
  }

  writeI32(address: number, value: number): void {
    this.check(address, 4);
    this.i32[address >> 2] = value | 0;
  }

  writeU32(address: number, value: number): void {
    this.check(address, 4);
    this.u32[address >> 2] = value >>> 0;
  }

  writeF32(address: number, value: number): void {
    this.check(address, 4);
    this.f32[address >> 2] = value;
  }

  /** 把一段 float 拷进去（宿主侧的 cudaMemcpy） */
  writeFloats(address: number, values: ArrayLike<number>): void {
    this.check(address, values.length * 4);
    this.f32.set(values as never, address >> 2);
  }

  readFloats(address: number, count: number): Float32Array {
    this.check(address, count * 4);
    return this.f32.slice(address >> 2, (address >> 2) + count);
  }

  writeInts(address: number, values: ArrayLike<number>): void {
    this.check(address, values.length * 4);
    this.i32.set(values as never, address >> 2);
  }

  readInts(address: number, count: number): Int32Array {
    this.check(address, count * 4);
    return this.i32.slice(address >> 2, (address >> 2) + count);
  }
}

/* ------------------------------------------------------------------ */
/* 合并访问分析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 一条 warp 级全局访存打到多少个不同的 32B 扇区。
 *
 * 真硬件的规则：一个 warp 的 32 个 lane 的地址被归并成对 L1 的扇区请求，
 * 落在同一个 32 字节扇区里的 lane 合并成一次传输。所以
 *
 *   - 完全合并（32 个 lane 读连续的 32 个 float = 128 字节）→ **4 个扇区**
 *   - 完全发散（每个 lane 隔得足够远）→ **32 个扇区**，也就是 8 倍的传输量
 *
 * 第 2 关的门槛 `sectorsPerRequest ≤ 4.5` 就是照着这条算的。
 *
 * 实现上用固定长度的插入排序去重：warp 里的地址通常已经是升序
 * （lane 顺着下标走），插入排序在近似有序的数据上是 O(n)，比开 Set 快得多，
 * 而且不产生垃圾 —— 这个函数每条访存指令都要调一次。
 */
// 多一格：插入排序在插入时会先把元素往后挪一位，n=31 时会摸到下标 31，
// 留出余量比推理边界安全（越界写在 TypedArray 上是静默丢弃，出了错查不出来）
const sectorScratch = new Int32Array(WARP_SIZE + 1);

export function countSectors(addresses: Int32Array, activeMask: number): number {
  let n = 0;
  for (let lane = 0; lane < WARP_SIZE; lane += 1) {
    if ((activeMask & (1 << lane)) === 0) continue;
    const sector = addresses[lane] >> 5; // / SECTOR_BYTES
    // 插入排序，顺带丢掉重复的
    let i = n;
    while (i > 0 && sectorScratch[i - 1] > sector) {
      sectorScratch[i] = sectorScratch[i - 1];
      i -= 1;
    }
    if (i > 0 && sectorScratch[i - 1] === sector) {
      // 已经有了，把刚才挪出来的位置填回去
      for (let j = i; j < n; j += 1) sectorScratch[j] = sectorScratch[j + 1];
      continue;
    }
    sectorScratch[i] = sector;
    n += 1;
  }
  return n;
}

/**
 * 一条 warp 级共享内存访存要发几路。
 *
 * 真硬件的规则，三条都要对：
 *  1. 共享内存分成 32 个 bank，bank 号 = (字节地址 / 4) % 32；
 *  2. 同一个 bank 的**不同**地址会串行化 —— n 个不同地址就是 n 路，冲突数 n-1；
 *  3. 同一个 bank 的**相同**地址是广播，**不算冲突**。
 *
 * 第 3 条是最容易做错也最容易被忽略的：`s[threadIdx.x / 2]` 这种一半 lane
 * 读同一个地址的写法，真卡上一点都不慢。做错了会误伤正确的实现。
 *
 * 返回「冲突路数」，也就是 ncu 的
 * `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_*` 的口径：
 * 完美无冲突时是 0。
 */
// bank 冲突分析的暂存。**复用**而不是每次分配 —— 这个函数每条共享内存
// 访存都要调一次，每次 new 32 个数组的话垃圾回收会吃掉一半的执行预算。
const bankAddresses = new Int32Array(SHARED_BANKS * WARP_SIZE);
const bankCounts = new Int32Array(SHARED_BANKS);
const touchedBanks = new Int32Array(SHARED_BANKS);

export function countBankConflicts(addresses: Int32Array, activeMask: number): number {
  let touched = 0;

  for (let lane = 0; lane < WARP_SIZE; lane += 1) {
    if ((activeMask & (1 << lane)) === 0) continue;
    const address = addresses[lane];
    const bank = (address >> 2) & (SHARED_BANKS - 1);
    const count = bankCounts[bank];
    if (count === 0) {
      touchedBanks[touched] = bank;
      touched += 1;
    }
    // 同一个 bank 上的相同地址是广播，不算一路
    const base = bank * WARP_SIZE;
    let seen = false;
    for (let i = 0; i < count; i += 1) {
      if (bankAddresses[base + i] === address) { seen = true; break; }
    }
    if (seen) continue;
    bankAddresses[base + count] = address;
    bankCounts[bank] = count + 1;
  }

  let conflicts = 0;
  for (let i = 0; i < touched; i += 1) {
    const bank = touchedBanks[i];
    if (bankCounts[bank] > 1) conflicts += bankCounts[bank] - 1;
    bankCounts[bank] = 0; // 清干净，下次直接用
  }
  return conflicts;
}
