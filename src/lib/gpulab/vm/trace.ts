/**
 * 访存轨迹
 *
 * 真卡上你**看不见**这些：一条访存指令里 32 个 lane 各自打到了哪个 32B 扇区、
 * 哪两个 lane 撞在同一个 bank 上。`ncu` 给的是聚合之后的数（扇区总数、
 * 冲突路数），而"为什么改一下下标 DRAM 字节就掉了 8 倍"要看的是那张图。
 *
 * ## 按需开启
 *
 * 和 racecheck 一样：不给就一行额外代码都不跑。每条访存记 32 个地址，
 * 一个稍大的 kernel 有几十万条访存 —— 常开的话内存和吞吐都受不了。
 * 所以工作台上是一个「采样一次」按钮，单独跑一遍。
 *
 * ## 为什么有上限
 *
 * 上限不是防御性编程，是**面板本身就用不了那么多**：
 * 学员一次只看得懂一条指令的一张图。超出上限的丢掉，
 * 并且**如实报告丢了多少** —— 悄悄截断会让人以为"这个 kernel 只访存了 512 次"。
 */
import { WARP_SIZE } from './memory';

export type AccessKind = 'load' | 'store';
export type AccessSpace = 'global' | 'shared' | 'local';

export interface AccessRecord {
  /** 源码行号 */
  line: number;
  kind: AccessKind;
  space: AccessSpace;
  /** 32 个 lane 的字节地址；不活跃的 lane 是 -1 */
  addresses: Int32Array;
  activeMask: number;
  /** 这一条打到几个 32B 扇区（global 才有意义） */
  sectors: number;
  /** 这一条要发几路（shared 才有意义）。0 表示无冲突 */
  bankConflicts: number;
  blockIndex: number;
  warpIndex: number;
}

export interface TraceOptions {
  /** 最多记多少条 */
  limit?: number;
}

export class AccessTrace {
  readonly records: AccessRecord[] = [];
  /** 因为超出上限被丢掉的条数 */
  truncated = 0;
  private readonly limit: number;

  constructor(options: TraceOptions = {}) {
    this.limit = options.limit ?? 512;
  }

  record(
    line: number, kind: AccessKind, space: AccessSpace,
    addresses: Int32Array, activeMask: number,
    sectors: number, bankConflicts: number,
    blockIndex: number, warpIndex: number
  ): void {
    if (this.records.length >= this.limit) {
      this.truncated += 1;
      return;
    }
    // 地址数组是 VM 复用的那一块，必须拷一份 —— 不拷的话
    // 所有记录最后都指向同一份内容，而且是最后一条的内容
    const copy = new Int32Array(WARP_SIZE);
    for (let lane = 0; lane < WARP_SIZE; lane += 1) {
      copy[lane] = (activeMask & (1 << lane)) ? addresses[lane] : -1;
    }
    this.records.push({
      line, kind, space, addresses: copy, activeMask,
      sectors, bankConflicts, blockIndex, warpIndex,
    });
  }
}

/** 一条访存记录按 32B 扇区聚合之后的样子 —— 热图画的就是这个 */
export interface SectorView {
  /** 扇区号（地址 >> 5），按升序 */
  sector: number;
  /** 打到这个扇区的 lane */
  lanes: number[];
}

export function sectorsOf(record: AccessRecord): SectorView[] {
  const byS = new Map<number, number[]>();
  for (let lane = 0; lane < WARP_SIZE; lane += 1) {
    const address = record.addresses[lane];
    if (address < 0) continue;
    const sector = address >> 5;
    const list = byS.get(sector);
    if (list) list.push(lane);
    else byS.set(sector, [lane]);
  }
  return [...byS.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sector, lanes]) => ({ sector, lanes }));
}

/** 一条共享内存访问按 bank 聚合 */
export interface BankView {
  bank: number;
  /** 打到这个 bank 的 lane，按地址分组 —— **同地址是广播，不算冲突** */
  groups: Array<{ address: number; lanes: number[] }>;
  /** 要发几路。1 表示无冲突 */
  ways: number;
}

export function banksOf(record: AccessRecord): BankView[] {
  const byBank = new Map<number, Map<number, number[]>>();
  for (let lane = 0; lane < WARP_SIZE; lane += 1) {
    const address = record.addresses[lane];
    if (address < 0) continue;
    // 共享内存按 4 字节一个 word，32 个 bank 轮流
    const bank = (address >> 2) % WARP_SIZE;
    let group = byBank.get(bank);
    if (!group) { group = new Map(); byBank.set(bank, group); }
    const lanesAt = group.get(address);
    if (lanesAt) lanesAt.push(lane);
    else group.set(address, [lane]);
  }
  const out: BankView[] = [];
  for (let bank = 0; bank < WARP_SIZE; bank += 1) {
    const group = byBank.get(bank);
    if (!group) { out.push({ bank, groups: [], ways: 0 }); continue; }
    const groups = [...group.entries()].map(([address, lanes]) => ({ address, lanes }));
    // **同一个 bank 里同一个地址是广播，一次就够** —— 冲突算的是不同地址的个数
    out.push({ bank, groups, ways: groups.length });
  }
  return out;
}
