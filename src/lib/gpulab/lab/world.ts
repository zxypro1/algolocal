/**
 * 一关的世界
 *
 * 学员面前是一台装了 CUDA 工具链的机器：磁盘上有 `.cu` 文件，终端里能敲
 * `nvcc` / `ncu` / `compute-sanitizer` / `nvidia-smi`。机器层直接复用
 * labkit（VFS、shell、coreutils），我们只往上装几个命令。
 *
 * **这一版学员只写 kernel，宿主侧是平台给的只读样板。**
 * design/gpulab.md 里定的是「宿主也用 CUDA C」，那需要一个 C 宿主解释器；
 * 前 16 关一行宿主代码都不用学员写，所以那一片留到第 17 关之前再做。
 * 现在宿主程序用**声明式**描述：缓冲区怎么填、kernel 怎么起、参数怎么传。
 */
import { createMachine, type Machine } from '../../labkit/machine';
import { createRandom } from '../../labkit/kernel';
import { GpuDevice, type DeviceOptions } from '../index';
import { B200, H100, type DeviceSpec } from '../device';
import type { ExecutableKernel } from '../ir/program';
import type { Dim3 } from '../vm/vm';
import { HOST_HEADERS } from '../host/headers';

/** 缓冲区里一开始装什么。要能写进 JSON，所以是声明而不是函数。 */
export type BufferFill =
  | { kind: 'zeros' }
  /** `value = offset + i * scale` */
  | { kind: 'iota'; scale?: number; offset?: number }
  | { kind: 'const'; value: number }
  /** 种子固定，所以每次跑出来的数据一模一样 */
  | { kind: 'random'; seed: number; min?: number; max?: number }
  | { kind: 'values'; values: number[] };

export interface BufferSpec {
  name: string;
  /** 元素个数 */
  length: number;
  /** 元素类型，默认 float */
  type?: 'float' | 'int';
  fill?: BufferFill;
}

/** 一次 kernel 启动 */
export interface LaunchSpec {
  kernel: string;
  grid: [number, number?, number?];
  block: [number, number?, number?];
  /** 实参：字符串是缓冲区名，数字是标量 */
  args: Array<string | number>;
}

/** `./bench` 跑起来是什么 */
export interface BenchSpec {
  /** 要编译的源文件，相对机器磁盘 */
  sources: string[];
  buffers: BufferSpec[];
  launches: LaunchSpec[];
}

export interface GpuWorldSpec {
  seed?: number;
  device?: 'H100' | 'B200';
  /** 显存大小，默认 64MB */
  globalBytes?: number;
  /** 每 block 共享内存上限，默认 48KB */
  sharedBytesPerBlock?: number;
  machine?: {
    hostname?: string;
    user?: string;
    cwd?: string;
    files?: Record<string, string>;
  };
  bench?: BenchSpec;
}

export interface CompiledArtifact {
  /** 编出来的可执行文件路径 */
  path: string;
  /** 名字 → kernel */
  kernels: Map<string, ExecutableKernel>;
  /**
   * 源码里的 `int main()`，编出来的宿主程序。
   *
   * 有它的时候 `./bench` 跑的是学员自己写的 `main`；没有的时候
   * 跑的是关卡在 `BenchSpec` 里声明的那套固定流程。
   * 前半程的关卡只写 kernel，后半程（KV cache、分页 KV、引擎组装、
   * 调度器）主要逻辑在宿主侧，走的就是前一条路。
   */
  host?: ExecutableKernel | null;
  /** 编译时用的源文件 */
  sources: string[];
}

export interface GpuWorld {
  machine: Machine;
  gpu: GpuDevice;
  spec: GpuWorldSpec;
  device: DeviceSpec;
  /** 已经 `nvcc -o` 出来的东西，按可执行文件名索引 */
  artifacts: Map<string, CompiledArtifact>;
  /** 缓冲区名 → 设备地址 */
  buffers: Map<string, { address: number; length: number; type: 'float' | 'int' }>;
  /** 最近一次 `./bench` 跑完的情况 */
  lastRun: BenchRun | null;
  run(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface BenchRun {
  artifact: CompiledArtifact;
  launches: LaunchSpec[];
  /** 真实墙钟耗时，只用来给「跑了多久」一个感觉，不作判定 */
  wallClockMs: number;
}

/** 按 fill 规格把一段数据造出来。种子固定 → 每次一模一样。 */
export function materialize(spec: BufferSpec, seed: number): Float32Array | Int32Array {
  const { length } = spec;
  const isInt = spec.type === 'int';
  const out = isInt ? new Int32Array(length) : new Float32Array(length);
  const fill = spec.fill ?? { kind: 'zeros' as const };

  switch (fill.kind) {
    case 'zeros':
      break;
    case 'const':
      out.fill(isInt ? fill.value | 0 : Math.fround(fill.value) as never);
      break;
    case 'iota': {
      const scale = fill.scale ?? 1;
      const offset = fill.offset ?? 0;
      for (let i = 0; i < length; i += 1) {
        out[i] = isInt ? (offset + i * scale) | 0 : Math.fround(offset + i * scale);
      }
      break;
    }
    case 'random': {
      // 用 labkit 的种子 RNG —— 和 opslab 是同一套，重放一定一致
      const random = createRandom(fill.seed ^ seed);
      const min = fill.min ?? -1;
      const max = fill.max ?? 1;
      for (let i = 0; i < length; i += 1) {
        const value = min + random.next() * (max - min);
        out[i] = isInt ? Math.floor(value) | 0 : Math.fround(value);
      }
      break;
    }
    case 'values':
      for (let i = 0; i < length; i += 1) {
        const value = fill.values[i % fill.values.length] ?? 0;
        out[i] = isInt ? value | 0 : Math.fround(value);
      }
      break;
  }
  return out;
}

export function toDim3(dims: [number, number?, number?]): Dim3 {
  return { x: dims[0], y: dims[1] ?? 1, z: dims[2] ?? 1 };
}

/**
 * 把世界搭起来。
 *
 * 装命令这一步由调用方做（见 lab/index.ts 的 buildWorld），
 * 这样 world 不用认识 nvcc / ncu 具体是什么。
 */
export function createGpuWorld(spec: GpuWorldSpec): GpuWorld {
  const deviceSpec = spec.device === 'B200' ? B200 : H100;

  const options: DeviceOptions = {
    globalBytes: spec.globalBytes ?? 64 * 1024 * 1024,
    sharedBytesPerBlock: spec.sharedBytesPerBlock ?? 48 * 1024,
    device: deviceSpec,
  };

  const machine = createMachine({
    hostname: spec.machine?.hostname ?? 'gpu-01',
    user: spec.machine?.user ?? 'root',
    cwd: spec.machine?.cwd ?? '/root',
    // 平台的头文件先铺进去，关卡自己的文件盖在上面 ——
    // 万一某一关要换掉某个头文件，它说了算
    files: { ...HOST_HEADERS, ...(spec.machine?.files ?? {}) },
  });

  const world: GpuWorld = {
    machine,
    gpu: new GpuDevice(options),
    spec,
    device: deviceSpec,
    artifacts: new Map(),
    buffers: new Map(),
    lastRun: null,
    async run(command: string) {
      const record = await machine.exec(command);
      return { stdout: record.stdout, stderr: record.stderr, code: record.code };
    },
  };

  return world;
}
