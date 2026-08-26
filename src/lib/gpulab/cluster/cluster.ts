/**
 * 一个 GPU 集群
 *
 * N 台设备，每台一份独立的显存与计量。集群这一层管三件事：
 * **地址空间的隔离**、**通信的计量**、以及虚拟时钟上的传输耗时。
 *
 * ## 地址为什么要带设备号
 *
 * 真卡上一个设备的指针在另一个设备上是非法的，误用会得到
 * illegal memory access。模拟器如果让它「碰巧能读到东西」，
 * 那就是这个项目最防的那种失败 —— 程序照跑，结果静静地错。
 *
 * 所以设备 d 的地址从 `(d + 1) * SPAN` 起算。SPAN 取 256MB，
 * 远大于关卡里任何一个标量参数（都是几千的量级），
 * 于是**从一个数就能看出它是不是指针、是哪张卡的指针**。
 */
import { GpuDevice, type DeviceOptions } from '../index';
import type { ExecutableKernel } from '../ir/program';
import type { Dim3, LaunchConfig } from '../vm/vm';
import {
  linkBetween, nodeOf, transferSeconds,
  type ClusterSpec, type LinkKind, type LinkSpec,
} from './topology';

/**
 * 每张卡的地址空间跨度。
 *
 * 取 2^25（32MB）而不是更大的数，是因为**带设备号的地址必须留在 int32 里**：
 * 宿主运行时对参数一律做 `| 0`（C 的 int 语义），
 * 设备 d 的基地址是 `(d + 1) * SPAN`，16 张卡时 2^28 会算到 24 亿，
 * 直接回绕成负数 —— 而回绕之后地址查不到、报错说的是"不在任何一次分配里"，
 * 完全看不出真正的原因。构造函数里有一道显式的守卫。
 */
export const DEVICE_SPAN = 1 << 25;

export class ClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterError';
  }
}

interface Allocation {
  /** 带设备号的基地址 */
  base: number;
  bytes: number;
  device: number;
}

/** 通信的计量。**全部是结构性的**，所以可以作门槛 */
export interface CommMetrics {
  /** 一共搬了多少字节 */
  bytes: number;
  /** 发了多少条消息 —— 不分桶会发几百条小的，门槛读它 */
  messages: number;
  /** 按链路种类分。张量并行跨机时 ib 会暴增 */
  bytesByLink: Record<LinkKind, number>;
  messagesByLink: Record<LinkKind, number>;
  /** 通信占用的虚拟时间，秒 */
  seconds: number;
  /**
   * 算法带宽与总线带宽。
   *
   * nccl-tests 的口径：algbw = 字节数 / 耗时，
   * busbw = algbw × 修正因子。all-reduce 的修正因子是 `2(n-1)/n` ——
   * 第 22 关要学员**自己数出**这个因子，而不是背下来。
   */
  algbw: number;
  busbw: number;
}

export function emptyCommMetrics(): CommMetrics {
  return {
    bytes: 0, messages: 0,
    bytesByLink: { nvlink: 0, pcie: 0, ib: 0 },
    messagesByLink: { nvlink: 0, pcie: 0, ib: 0 },
    seconds: 0, algbw: 0, busbw: 0,
  };
}

export interface ClusterOptions extends DeviceOptions {
  spec: ClusterSpec;
}

export class Cluster {
  readonly devices: GpuDevice[] = [];
  readonly spec: ClusterSpec;
  readonly comm = emptyCommMetrics();
  /** 当前 cudaSetDevice 选中的卡 */
  current = 0;

  private readonly allocations: Allocation[] = [];
  /**
   * 每条链路各自的忙碌时间。
   *
   * 多张卡同时通信时，总耗时是**最慢那条链路**的时间，
   * 不是所有传输之和 —— ring all-reduce 的全部意义就在这里。
   */
  private readonly linkBusy = new Map<string, number>();

  constructor(options: ClusterOptions) {
    this.spec = options.spec;
    const highest = (options.spec.devices + 1) * DEVICE_SPAN;
    if (highest > 0x7fffffff) {
      throw new ClusterError(
        `${options.spec.devices} 张卡的地址空间放不进 int32（要 ${highest}）—— `
        + '要么减少卡数，要么调小 DEVICE_SPAN'
      );
    }
    const perDevice = options.globalBytes ?? 16 * 1024 * 1024;
    if (perDevice > DEVICE_SPAN) {
      throw new ClusterError(
        `每张卡要 ${perDevice} 字节，超过了地址空间跨度 ${DEVICE_SPAN}`
      );
    }
    for (let i = 0; i < options.spec.devices; i += 1) {
      this.devices.push(new GpuDevice({
        globalBytes: options.globalBytes ?? 16 * 1024 * 1024,
        sharedBytesPerBlock: options.sharedBytesPerBlock,
        device: options.device,
        maxWarpInsts: options.maxWarpInsts,
      }));
    }
  }

  get count(): number {
    return this.devices.length;
  }

  setDevice(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new ClusterError(`没有编号 ${index} 的设备 —— 一共 ${this.count} 张卡`);
    }
    this.current = index;
  }

  /** 在当前设备上分配，返回**带设备号的**地址 */
  malloc(bytes: number): number {
    const device = this.current;
    const local = this.devices[device].malloc(bytes);
    const base = (device + 1) * DEVICE_SPAN + local;
    this.allocations.push({ base, bytes, device });
    return base;
  }

  /** 一个带设备号的地址属于哪块分配 */
  private lookup(address: number): Allocation | null {
    if (address < DEVICE_SPAN) return null;
    for (const item of this.allocations) {
      if (address >= item.base && address < item.base + item.bytes) return item;
    }
    return null;
  }

  /** 把带设备号的地址翻成设备本地地址，同时验它属于哪张卡 */
  localAddress(address: number, expected: number, what: string): number {
    const found = this.lookup(address);
    if (!found) {
      throw new ClusterError(
        `${what}：地址 ${address} 不在任何一次 cudaMalloc 的范围里`
      );
    }
    if (found.device !== expected) {
      throw new ClusterError(
        `${what}：这是设备 ${found.device} 的指针，却在设备 ${expected} 上用 —— `
        + '真卡上这是 illegal memory access。先 cudaSetDevice，或者用 cudaMemcpyPeer 搬过去'
      );
    }
    return address - (found.device + 1) * DEVICE_SPAN;
  }

  /** 一个数看起来像不像指针 */
  isPointer(value: number): boolean {
    return value >= DEVICE_SPAN;
  }

  copyIn(address: number, values: ArrayLike<number>): void {
    const found = this.lookup(address);
    if (!found) throw new ClusterError(`地址 ${address} 不在任何一次分配里`);
    this.devices[found.device].copyIn(address - (found.device + 1) * DEVICE_SPAN, values);
  }

  copyOut(address: number, count: number): Float32Array {
    const found = this.lookup(address);
    if (!found) throw new ClusterError(`地址 ${address} 不在任何一次分配里`);
    return this.devices[found.device].copyOut(address - (found.device + 1) * DEVICE_SPAN, count);
  }

  copyOutInts(address: number, count: number): Int32Array {
    const found = this.lookup(address);
    if (!found) throw new ClusterError(`地址 ${address} 不在任何一次分配里`);
    return this.devices[found.device].copyOutInts(address - (found.device + 1) * DEVICE_SPAN, count);
  }

  launch(name: string, kernel: ExecutableKernel, config: LaunchConfig, args: number[]): void {
    const device = this.current;
    const translated = args.map((arg, index) => (
      this.isPointer(arg)
        ? this.localAddress(arg, device, `${name} 的第 ${index + 1} 个参数`)
        : arg
    ));
    this.devices[device].launch(kernel, config, translated);
  }

  /**
   * 设备之间搬一段字节。
   *
   * 这是 `cudaMemcpyPeer` 与 NCCL 的公共底座。
   * 计量在这里做：字节数、消息数、走了哪条链路、占了多久。
   */
  peerCopy(dst: number, dstDevice: number, src: number, srcDevice: number, bytes: number): void {
    if (bytes < 0) throw new ClusterError(`拷贝的字节数是负的：${bytes}`);
    const dstLocal = this.localAddress(dst, dstDevice, 'cudaMemcpyPeer 的目标');
    const srcLocal = this.localAddress(src, srcDevice, 'cudaMemcpyPeer 的来源');

    const to = this.devices[dstDevice].memory;
    const from = this.devices[srcDevice].memory;
    if (dstLocal + bytes > to.capacity || srcLocal + bytes > from.capacity) {
      throw new ClusterError(`cudaMemcpyPeer 越界：搬 ${bytes} 字节`);
    }
    new Uint8Array(to.bytes, dstLocal, bytes).set(new Uint8Array(from.bytes, srcLocal, bytes));

    if (srcDevice === dstDevice) return;   // 同卡内的拷贝不算通信
    this.account(srcDevice, dstDevice, bytes);
  }

  /** 记一次跨卡传输 */
  account(from: number, to: number, bytes: number): void {
    const link = linkBetween(from, to, this.spec);
    const seconds = transferSeconds(bytes, link);

    this.comm.bytes += bytes;
    this.comm.messages += 1;
    this.comm.bytesByLink[link.kind] += bytes;
    this.comm.messagesByLink[link.kind] += 1;

    // 同一条链路上的传输是串行的；不同链路可以同时忙。
    // 于是总通信时间取所有链路里最忙的那一条 ——
    // ring all-reduce 之所以能把 n 张卡的带宽都用上，就是因为
    // 每一步用的都是不同的链路。
    const key = `${Math.min(from, to)}-${Math.max(from, to)}`;
    const busy = (this.linkBusy.get(key) ?? 0) + seconds;
    this.linkBusy.set(key, busy);
    if (busy > this.comm.seconds) this.comm.seconds = busy;
  }

  /**
   * 按 nccl-tests 的口径算带宽。
   *
   * `payloadBytes` 是**一次集合操作在用户看来搬了多少**
   * （all-reduce 就是缓冲区大小），`factor` 是集合操作的修正因子。
   */
  finishBandwidth(payloadBytes: number, factor: number): void {
    if (this.comm.seconds <= 0) return;
    this.comm.algbw = payloadBytes / this.comm.seconds;
    this.comm.busbw = this.comm.algbw * factor;
  }

  nodeOf(device: number): number {
    return nodeOf(device, this.spec);
  }

  linkFor(a: number, b: number): LinkSpec {
    return linkBetween(a, b, this.spec);
  }

  reset(): void {
    for (const device of this.devices) device.reset();
    this.allocations.length = 0;
    this.linkBusy.clear();
    this.current = 0;
    Object.assign(this.comm, emptyCommMetrics());
  }
}
