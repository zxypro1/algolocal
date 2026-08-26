/**
 * 竞态检测 —— 等价于 `compute-sanitizer --tool racecheck`
 *
 * **这个文件不做，整个项目的价值主张就不成立。**
 *
 * 我们的执行器是 warp 锁步、完全确定的：block 里的 warp 按固定顺序轮转。
 * 于是**一个有竞态的 kernel 在这里会给出一个稳定的结果**，两种情况都很糟：
 *
 *  1. 那个结果**恰好是对的** —— 典型是「后面的 warp 读前面 warp 刚写的」，
 *     在我们固定的轮转顺序下永远读得到。学员跑一万遍都对，没有理由怀疑，
 *     然后带着一份真卡上会炸的代码出门。
 *  2. 那个结果是错的 —— 学员会把它当成逻辑 bug 去调，反复重跑也不会看到
 *     真硬件上那种「时好时坏」，于是学不到「这是竞态」这件事本身。
 *
 * 两种都不会自己暴露（重跑一万遍也是同一个结果），必须主动检测。
 * 不做这个，「在这里学会的换到真卡上成立」就是空话。
 *
 * ## 判据
 *
 * 两次访问构成竞态，当且仅当：
 *  1. 打到同一个 4 字节字；
 *  2. 来自**不同的线程**；
 *  3. 至少有一次是写；
 *  4. 两者之间**没有屏障**把它们分开。
 *
 * 第 4 条是核心。`__syncthreads()` 把 block 的执行切成一个个「纪元」，
 * 同一纪元内的两次冲突访问才是竞态；跨纪元的被屏障排好了序，不是。
 *
 * 跨 block 的访问永远算并发 —— CUDA 不保证 block 之间的任何顺序，
 * 哪怕我们的执行器是一个个按顺序跑的。**这一点必须按语义判而不是按我们的
 * 执行顺序判**，否则又变成「只在这个模拟器上成立」。
 *
 * ## 已知的近似
 *
 * 每个字只记**最近一次**读和最近一次写。于是「A 读、B 读、C 写」这种
 * 三方竞态只会报出 B–C 那一对，A–C 漏掉。真的 racecheck 也是同类近似
 * （影子内存放不下所有历史访问）—— 漏报的那些通常和报出来的是同一个 bug。
 *
 * ## 开销
 *
 * 每次访存多四次影子读写，整体慢两三倍。所以它是**按需开启**的：
 * 平时跑不带，判定时单独再跑一遍带上 —— 和现实里你不会把
 * compute-sanitizer 挂在生产上是一个道理。
 */
export type AccessKind = 'read' | 'write';

export interface ThreadId {
  x: number;
  y: number;
  z: number;
}

export interface AccessSite {
  kind: AccessKind;
  thread: ThreadId;
  block: ThreadId;
  /** 源码行号 */
  line: number;
}

export interface RaceReport {
  space: 'global' | 'shared';
  /** 字节地址 */
  address: number;
  /** 先发生的那次（按我们的执行顺序） */
  first: AccessSite;
  /** 后发生的那次 */
  second: AccessSite;
}

export interface SanitizerReport {
  races: RaceReport[];
  /** 报出来的条数上限到了之后还漏了多少 —— 不写出来就成了「只有这几条」 */
  truncated: number;
}

const MAX_REPORTS = 32;

/**
 * 影子内存。
 *
 * 每个 4 字节字四个槽：最近一次写的线程与纪元、最近一次读的线程与纪元。
 * 线程编号里 0 表示「没人碰过」，所以存的是 threadKey + 1。
 */
class Shadow {
  private writer: Int32Array;
  private writeStamp: Int32Array;
  private writeLine: Int32Array;
  private reader: Int32Array;
  private readStamp: Int32Array;
  private readLine: Int32Array;

  constructor(words: number) {
    this.writer = new Int32Array(words);
    this.writeStamp = new Int32Array(words);
    this.writeLine = new Int32Array(words);
    this.reader = new Int32Array(words);
    this.readStamp = new Int32Array(words);
    this.readLine = new Int32Array(words);
  }

  reset(): void {
    this.writer.fill(0);
    this.writeStamp.fill(0);
    this.writeLine.fill(0);
    this.reader.fill(0);
    this.readStamp.fill(0);
    this.readLine.fill(0);
  }

  get words(): number {
    return this.writer.length;
  }

  lastWriter(word: number): number { return this.writer[word]; }
  lastWriteStamp(word: number): number { return this.writeStamp[word]; }
  lastWriteLine(word: number): number { return this.writeLine[word]; }
  lastReader(word: number): number { return this.reader[word]; }
  lastReadStamp(word: number): number { return this.readStamp[word]; }
  lastReadLine(word: number): number { return this.readLine[word]; }

  recordWrite(word: number, thread: number, stamp: number, line: number): void {
    this.writer[word] = thread + 1;
    this.writeStamp[word] = stamp;
    this.writeLine[word] = line;
  }

  recordRead(word: number, thread: number, stamp: number, line: number): void {
    this.reader[word] = thread + 1;
    this.readStamp[word] = stamp;
    this.readLine[word] = line;
  }
}

export interface DetectorOptions {
  /** 全局内存要盯多少字节 —— 按这次 launch 实际分配的量给就行 */
  globalBytes: number;
  sharedBytes: number;
  blockDim: { x: number; y: number; z: number };
  gridDim: { x: number; y: number; z: number };
}

export class RaceDetector {
  private readonly globalShadow: Shadow;
  private readonly sharedShadow: Shadow;
  private readonly blockDim: { x: number; y: number; z: number };
  private readonly reports: RaceReport[] = [];
  private truncated = 0;

  /** 当前 block 的线性编号，以及它走到第几个纪元 */
  private blockId = 0;
  private blockCoord: ThreadId = { x: 0, y: 0, z: 0 };
  private epoch = 0;

  constructor(options: DetectorOptions) {
    this.globalShadow = new Shadow(Math.max(1, Math.ceil(options.globalBytes / 4)));
    this.sharedShadow = new Shadow(Math.max(1, Math.ceil(options.sharedBytes / 4)));
    this.blockDim = options.blockDim;
  }

  /** 换一个 block：共享内存是新的，纪元从头算 */
  beginBlock(id: number, coord: ThreadId): void {
    this.blockId = id;
    this.blockCoord = coord;
    this.epoch = 0;
    this.sharedShadow.reset();
  }

  /** 整个 block 过了一次屏障 */
  passBarrier(): void {
    this.epoch += 1;
  }

  /**
   * 记一次访问并查竞态。
   *
   * `tid` 是 block 内的线性线程号。地址已经是字节地址。
   */
  record(
    space: 'global' | 'shared',
    address: number,
    tid: number,
    kind: AccessKind,
    line: number
  ): void {
    const shadow = space === 'global' ? this.globalShadow : this.sharedShadow;
    const word = address >> 2;
    if (word < 0 || word >= shadow.words) return;

    // 线程身份要带上 block —— 不同 block 的同号线程不是同一个线程
    const threadKey = this.blockId * 1024 + tid;
    // 纪元只在同一个 block 内有意义；跨 block 用一个永不相等的标记
    const stamp = this.blockId * 65536 + this.epoch + 1;

    const priorWriter = shadow.lastWriter(word);
    if (priorWriter !== 0 && priorWriter - 1 !== threadKey) {
      if (this.concurrent(shadow.lastWriteStamp(word), stamp, priorWriter - 1, threadKey)) {
        this.report(space, address, 'write', priorWriter - 1, shadow.lastWriteLine(word), kind, threadKey, line);
      }
    }

    if (kind === 'write') {
      const priorReader = shadow.lastReader(word);
      if (priorReader !== 0 && priorReader - 1 !== threadKey) {
        if (this.concurrent(shadow.lastReadStamp(word), stamp, priorReader - 1, threadKey)) {
          this.report(space, address, 'read', priorReader - 1, shadow.lastReadLine(word), kind, threadKey, line);
        }
      }
      shadow.recordWrite(word, threadKey, stamp, line);
    } else {
      shadow.recordRead(word, threadKey, stamp, line);
    }
  }

  /**
   * 两次访问之间有没有屏障把它们分开。
   *
   * 同一个 block 内：纪元不同就说明中间过了 `__syncthreads()`，有序，不是竞态。
   * 不同 block：CUDA 不保证任何顺序，一律算并发 —— **按语义判，不按我们的
   * 执行顺序判**，否则这个检测就只在这个模拟器上成立。
   */
  private concurrent(priorStamp: number, stamp: number, priorThread: number, thread: number): boolean {
    const priorBlock = (priorThread / 1024) | 0;
    const block = (thread / 1024) | 0;
    if (priorBlock !== block) return true;
    return priorStamp === stamp;
  }

  private report(
    space: 'global' | 'shared', address: number,
    priorKind: AccessKind, priorThread: number, priorLine: number,
    kind: AccessKind, thread: number, line: number
  ): void {
    if (this.reports.length >= MAX_REPORTS) {
      this.truncated += 1;
      return;
    }
    this.reports.push({
      space,
      address,
      first: {
        kind: priorKind,
        thread: this.threadCoord(priorThread % 1024),
        block: this.blockCoordOf((priorThread / 1024) | 0),
        line: priorLine,
      },
      second: {
        kind,
        thread: this.threadCoord(thread % 1024),
        block: this.blockCoordOf((thread / 1024) | 0),
        line,
      },
    });
  }

  /** 线性线程号 → (x, y, z)，和 CUDA 里 threadIdx 的排布一致 */
  private threadCoord(tid: number): ThreadId {
    const { x, y } = this.blockDim;
    return {
      x: tid % x,
      y: ((tid / x) | 0) % y,
      z: (tid / (x * y)) | 0,
    };
  }

  private blockCoordOf(id: number): ThreadId {
    return id === this.blockId ? this.blockCoord : { x: id, y: 0, z: 0 };
  }

  result(): SanitizerReport {
    return { races: this.reports, truncated: this.truncated };
  }

  get raceCount(): number {
    return this.reports.length + this.truncated;
  }
}

/**
 * 按 compute-sanitizer 的样子把报告打出来。
 *
 * 格式贴上游是「接口真实」的一部分：学员在这里读到的报错，
 * 换到真卡上跑 `compute-sanitizer --tool racecheck` 看到的是同一种东西。
 */
export function formatRaceReports(report: SanitizerReport, kernelName: string): string {
  if (!report.races.length) {
    return `========= COMPUTE-SANITIZER\n========= RACECHECK SUMMARY: 0 hazards displayed (0 errors, 0 warnings)`;
  }

  const lines: string[] = ['========= COMPUTE-SANITIZER'];
  for (const race of report.races) {
    const one = race.first;
    const two = race.second;
    lines.push(
      `========= ERROR: Race reported between ${cap(one.kind)} access and ${cap(two.kind)} access ` +
      `at 0x${(race.address >>> 0).toString(16)} in __${race.space}__ memory`
    );
    lines.push(`=========     ${cap(one.kind)} by thread ${coord(one.thread)} in block ${coord(one.block)} at ${kernelName}.cu:${one.line}`);
    lines.push(`=========     ${cap(two.kind)} by thread ${coord(two.thread)} in block ${coord(two.block)} at ${kernelName}.cu:${two.line}`);
    lines.push('=========');
  }
  const total = report.races.length + report.truncated;
  lines.push(
    `========= RACECHECK SUMMARY: ${report.races.length} hazards displayed ` +
    `(${total} errors, 0 warnings)` +
    (report.truncated ? ` —— 还有 ${report.truncated} 条没显示` : '')
  );
  return lines.join('\n');
}

function cap(kind: AccessKind): string {
  return kind === 'read' ? 'Read' : 'Write';
}

function coord(id: ThreadId): string {
  return `(${id.x},${id.y},${id.z})`;
}
