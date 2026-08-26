/**
 * 宿主运行时：把 `hostcall` / `launch` 两条指令接到真正的设备上
 *
 * VM 只负责把指令翻成一次调用，具体做什么在这里。分开是因为 VM 那一层
 * 不该知道 `GpuDevice` 的存在 —— 它跑的是指令，不是 CUDA。
 *
 * ## 宿主内存 = 那一个线程的 local memory
 *
 * 宿主程序在 VM 里就是 grid 1 / block 1 的一个线程，它的局部数组落在
 * local memory 里。于是 `cudaMemcpy(..., cudaMemcpyHostToDevice)` 的
 * 「主机端指针」就是 local 空间的地址，「设备端指针」是 global 空间的地址。
 * **两个空间是真的分开的**，拿主机指针当设备指针用会读到别的东西，
 * 和真卡上一样 —— 这正是 `cudaMemcpyKind` 那个参数存在的理由。
 */
import type { HostServices } from '../vm/vm';
import type { Dim3 } from '../vm/vm';
import { HOST } from '../ir/program';
import { ContainerStore, HostRuntimeError } from './containers';

/** 重放时交给设备的一步 */
export type GraphReplayNode =
  | { kind: 'launch'; name: string; grid: Dim3; block: Dim3; args: number[]; line: number }
  | { kind: 'copy'; dst: number; src: number; bytes: number; copyKind: number };

export interface HostEnvironment {
  /** 分配设备显存，返回字节地址 */
  cudaMalloc(bytes: number): number;
  cudaFree(address: number): void;
  /** 在两个地址空间之间搬字节 */
  copy(dst: number, src: number, bytes: number, kind: number): void;
  memset(address: number, value: number, bytes: number): void;
  /** 起一个 kernel，同步执行完 */
  launch(name: string, grid: Dim3, block: Dim3, args: number[], line: number): void;
  /**
   * 重放一整张 graph。
   *
   * 和逐个 `launch` 的区别只有一处，但那正是 CUDA Graph 的全部意义：
   * **提交开销只算一次**。kernel 该干的活一点没少。
   */
  replay(nodes: GraphReplayNode[]): void;
  /** 收集标准输出 */
  write(text: string): void;

  /* ---- 多卡。单卡的关卡不给这几个，用到就报错 ---- */
  deviceCount?(): number;
  /** 往宿主端的 int 数组里写 —— ncclCommInitAll 的出参是这么给的 */
  writeHostInts?(address: number, values: number[]): void;
  /** 读宿主端的 int 数组 —— ncclCommInitAll 的 devlist 是这么收的 */
  readHostInts?(address: number, count: number): number[];
  setDevice?(index: number): void;
  getDevice?(): number;
  peerCopy?(dst: number, dstDevice: number, src: number, srcDevice: number, bytes: number): void;
  /** 流水线步边界 */
  pipeStep?(): void;
  /** 一次集合操作。`kind` 是操作名，`ranks` 是每个 rank 的收发缓冲区 */
  collective?(
    kind: string,
    ranks: Array<{ device: number; send: number; recv: number }>,
    count: number,
    op: number,
    root: number
  ): void;
  /**
   * 关卡在 `BenchSpec.buffers` 里声明的第 index 个缓冲区。
   *
   * 真实的推理引擎从权重加载器拿张量，这里是同一件事的最小版本 ——
   * 数据由平台准备（所以判定知道它是什么），学员的 `main` 拿到的是
   * 一个正常的设备指针。
   */
  buffer(index: number): { address: number; length: number };
}

/** 一次录下来的操作：起 kernel，或者一次拷贝 */
type GraphNode = LaunchNode | CopyNode;

interface CopyNode {
  kind: 'copy';
  dst: number;
  src: number;
  bytes: number;
  copyKind: number;
}

interface LaunchNode {
  kind: 'launch';
  name: string;
  grid: Dim3;
  block: Dim3;
  /**
   * **录的是捕获那一刻的实参值。**
   *
   * 这正是 CUDA Graph 最容易踩的地方：指针是稳定的地址，重放没问题；
   * 而按值传的标量（比如 `len`）录下来就定死了，之后再变也不会生效。
   * 真实引擎的解法是把会变的量放进显存、让 kernel 从指针读 ——
   * 第 20 关考的就是这件事。
   */
  args: number[];
  line: number;
}

/** group 里攒着的一次集合操作 */
interface PendingCollective {
  kind: string;
  send: number;
  recv: number;
  count: number;
  op: number;
  comm: number;
  root: number;
}

/** 一个宿主程序跑起来需要的全部状态 */
export class HostRuntime implements HostServices {
  private readonly containers = new ContainerStore();
  /** 正在捕获时，launch record 到这里而不是执行 */
  private capturing: GraphNode[] | null = null;
  private readonly graphs: GraphNode[][] = [];
  private readonly execs: GraphNode[][] = [];
  /**
   * 正在攒的 group。
   *
   * NCCL 的调用是**流序异步**的：单线程管多设备时必须用 group 语义，
   * 因为每个调用都可能阻塞在等对端上。攒到 `ncclGroupEnd` 一起发，
   * 死锁才不会发生 —— 这一条是 NVIDIA 文档里明写的。
   */
  private group: PendingCollective[] | null = null;
  private commCount = 0;

  constructor(
    private readonly env: HostEnvironment,
    /** printf 的格式串常量池 */
    private readonly strings: string[]
  ) {}

  call(fn: number, args: number[], line: number): number {
    try {
      return this.dispatch(fn, args);
    } catch (error) {
      if (error instanceof HostRuntimeError) {
        // 已经带行号的不要再包一层 —— 否则会打成「第 49 行：第 49 行：…」
        if (/^第 \d+ 行：/.test(error.message)) throw error;
        throw new HostRuntimeError(`第 ${line} 行：${error.message}`);
      }
      throw error;
    }
  }

  launch(name: string, grid: Dim3, block: Dim3, args: number[], line: number): void {
    if (this.capturing) {
      // 捕获期间**不执行**，只录下来 —— 和真 CUDA 一样
      this.capturing.push({ kind: 'launch', name, grid, block, args: args.slice(), line });
      return;
    }
    this.env.launch(name, grid, block, args, line);
  }

  private requireCluster(what: string): HostEnvironment {
    if (!this.env.deviceCount) {
      throw new HostRuntimeError(`${what}：这一关只有一张卡，没有集群`);
    }
    return this.env;
  }

  /**
   * 把一次集合操作攒进 group。
   *
   * 不在 group 里的话立刻发 —— 真 NCCL 也允许单卡不用 group，
   * 但**单线程管多设备时不用 group 会死锁**，所以这里不在 group 里
   * 而通信子多于一个时明确报错，而不是让它跑出一个看似正常的结果。
   */
  private enqueue(
    kind: string, send: number, recv: number, count: number,
    op: number, comm: number, root: number
  ): number {
    const item: PendingCollective = { kind, send, recv, count, op, comm, root };
    if (this.group) {
      this.group.push(item);
      return 0;
    }
    if (this.commCount > 1) {
      throw new HostRuntimeError(
        `${kind}：单线程管多张卡时必须把调用放在 ncclGroupStart / ncclGroupEnd 之间 —— `
        + '每个 NCCL 调用都可能阻塞在等对端上，不成组会死锁'
      );
    }
    this.flushGroup([item]);
    return 0;
  }

  private flushGroup(pending: PendingCollective[]): void {
    if (!pending.length) return;
    const env = this.requireCluster('NCCL');
    // 同一种操作、同一批 rank 的调用凑成一次集合操作
    const byKind = new Map<string, PendingCollective[]>();
    for (const item of pending) {
      const key = `${item.kind}:${item.count}:${item.op}:${item.root}`;
      const list = byKind.get(key);
      if (list) list.push(item);
      else byKind.set(key, [item]);
    }
    for (const [, list] of byKind) {
      const ranks = list.map((item) => ({
        device: item.comm, send: item.send, recv: item.recv,
      }));
      env.collective!(list[0].kind, ranks, list[0].count, list[0].op, list[0].root);
    }
  }

  private dispatch(fn: number, args: number[]): number {
    const store = this.containers;
    switch (fn) {
      /* ---- CUDA runtime ---- */
      case HOST.cudaMalloc:
        return this.env.cudaMalloc(args[0] | 0);
      case HOST.cudaFree:
        this.env.cudaFree(args[0] | 0);
        return 0;
      case HOST.cudaMemcpy:
        if (this.capturing) {
          // 拷贝也要进 graph。**不录的话它会在捕获那一刻就执行**，
          // 之后每次重放都少做一步 —— 而程序照跑，结果静静地错。
          this.capturing.push({
            kind: 'copy',
            dst: args[0] | 0, src: args[1] | 0, bytes: args[2] | 0, copyKind: args[3] | 0,
          });
          return 0;
        }
        this.env.copy(args[0] | 0, args[1] | 0, args[2] | 0, args[3] | 0);
        return 0;
      case HOST.cudaMemset:
        this.env.memset(args[0] | 0, args[1] | 0, args[2] | 0);
        return 0;
      case HOST.lab_buffer:
        return this.env.buffer(args[0] | 0).address;
      case HOST.lab_buffer_len:
        return this.env.buffer(args[0] | 0).length;

      /* ---- CUDA Graph ---- */
      case HOST.cudaStreamBeginCapture:
        if (this.capturing) throw new HostRuntimeError('已经在捕获中了，不能嵌套');
        this.capturing = [];
        return 0;
      case HOST.cudaStreamEndCapture: {
        if (!this.capturing) throw new HostRuntimeError('没有在捕获，cudaStreamEndCapture 无从结束');
        this.graphs.push(this.capturing);
        this.capturing = null;
        return this.graphs.length;
      }
      case HOST.cudaGraphInstantiate: {
        const graph = this.graphs[(args[0] | 0) - 1];
        if (!graph) throw new HostRuntimeError(`没有编号 ${args[0]} 的 graph`);
        this.execs.push(graph);
        return this.execs.length;
      }
      case HOST.cudaGraphLaunch: {
        const exec = this.execs[(args[0] | 0) - 1];
        if (!exec) {
          throw new HostRuntimeError(
            (args[0] | 0) === 0
              ? 'graphExec 句柄是 0 —— 变量还没被 cudaGraphInstantiate 填上'
              : `没有编号 ${args[0]} 的 graphExec`
          );
        }
        this.env.replay(exec.map((node) => (
          node.kind === 'launch' ? { ...node, args: node.args.slice() } : { ...node }
        )));
        return 0;
      }
      case HOST.cudaGraphDestroy:
      case HOST.cudaGraphExecDestroy:
        // 和 cudaFree 一样：句柄不回收。峰值计量要的是"一共开过多少"，
        // 能回收就量不出差别了。写出来仍然是对的习惯。
        return 0;

      /* ---- 多卡 ---- */
      case HOST.cudaGetDeviceCount:
        return this.requireCluster('cudaGetDeviceCount').deviceCount!();
      case HOST.cudaGetDevice:
        return this.requireCluster('cudaGetDevice').getDevice!();
      case HOST.cudaSetDevice:
        this.requireCluster('cudaSetDevice').setDevice!(args[0] | 0);
        return 0;
      case HOST.pipe_step:
        this.requireCluster('pipe_step').pipeStep!();
        return 0;
      case HOST.cudaMemcpyPeer:
        this.requireCluster('cudaMemcpyPeer').peerCopy!(
          args[0] | 0, args[1] | 0, args[2] | 0, args[3] | 0, args[4] | 0
        );
        return 0;

      /* ---- NCCL ---- */
      case HOST.ncclCommInitAll: {
        // 真签名是 (comms, ndev, devlist)。通信子在这个子集里就是
        // **它所在的那张卡的编号** —— 于是集合操作能知道环上每一跳
        // 走的是哪条链路。devlist 传 0 表示用 0..ndev-1。
        const count = args[1] | 0;
        const env = this.requireCluster('ncclCommInitAll');
        if (count > env.deviceCount!()) {
          throw new HostRuntimeError(
            `要 ${count} 个通信子，但一共只有 ${env.deviceCount!()} 张卡`
          );
        }
        this.commCount = count;
        // 真 API 是 ncclCommInitAll(comms, ndev, devlist)，把每个设备的
        // 通信子写进 comms。这个子集里通信子就是 rank 号本身，
        // devlist 省掉了（设备固定是 0..n-1），这条偏差写在 nccl.h 里。
        const devlist = (args[2] | 0) !== 0
          ? env.readHostInts!(args[2] | 0, count)
          : Array.from({ length: count }, (_, i) => i);
        for (const device of devlist) {
          if (device < 0 || device >= env.deviceCount!()) {
            throw new HostRuntimeError(
              `devlist 里有编号 ${device} 的设备，但一共只有 ${env.deviceCount!()} 张卡`
            );
          }
        }
        env.writeHostInts!(args[0] | 0, devlist);
        return 0;
      }
      case HOST.ncclCommDestroy:
        return 0;
      case HOST.ncclGroupStart:
        if (this.group) throw new HostRuntimeError('ncclGroupStart 不能嵌套');
        this.group = [];
        return 0;
      case HOST.ncclGroupEnd: {
        if (!this.group) throw new HostRuntimeError('没有在 group 里，ncclGroupEnd 无从结束');
        const pending = this.group;
        this.group = null;
        this.flushGroup(pending);
        return 0;
      }
      // 参数位置按真 nccl.h：
      //   AllReduce(send, recv, count, datatype, op, comm, stream)
      //   AllGather(send, recv, sendcount, datatype, comm, stream)
      //   ReduceScatter(send, recv, recvcount, datatype, op, comm, stream)
      //   Broadcast(send, recv, count, datatype, root, comm, stream)
      //   Reduce(send, recv, count, datatype, op, root, comm, stream)
      case HOST.ncclAllReduce:
        return this.enqueue('allreduce', args[0], args[1], args[2] | 0, args[4] | 0, args[5] | 0, -1);
      case HOST.ncclAllGather:
        return this.enqueue('allgather', args[0], args[1], args[2] | 0, 0, args[4] | 0, -1);
      case HOST.ncclReduceScatter:
        return this.enqueue('reducescatter', args[0], args[1], args[2] | 0, args[4] | 0, args[5] | 0, -1);
      case HOST.ncclBroadcast:
        return this.enqueue('broadcast', args[0], args[1], args[2] | 0, 0, args[5] | 0, args[4] | 0);
      case HOST.ncclReduce:
        return this.enqueue('reduce', args[0], args[1], args[2] | 0, args[4] | 0, args[6] | 0, args[5] | 0);
      case HOST.ncclSend:
      case HOST.ncclRecv:
        throw new HostRuntimeError(
          'ncclSend / ncclRecv 还没做 —— 点对点请用 cudaMemcpyPeer'
        );

      case HOST.cudaDeviceSynchronize:
        // 我们的 launch 是同步的，所以这里没有实际工作。**保留它不是装样子**：
        // 真卡上少写这一句、紧接着读回结果，是最经典的一类 bug，
        // 关卡的正文会讲到，代码里出现过学员才有印象。
        return 0;

      /* ---- 标准输出 ---- */
      case HOST.printf: {
        const format = this.strings[args[0] | 0];
        if (format === undefined) throw new HostRuntimeError('printf 的格式串丢了');
        this.env.write(formatPrintf(format, args.slice(1)));
        return 0;
      }

      /* ---- vec ---- */
      case HOST.vec_new: return store.vecNew();
      case HOST.vec_push: store.vec(args[0]).push(args[1] | 0); return 0;
      case HOST.vec_pop: {
        const list = store.vec(args[0]);
        if (!list.length) throw new HostRuntimeError('vec_pop 在空的 vec 上');
        return list.pop() as number;
      }
      case HOST.vec_get: {
        const list = store.vec(args[0]);
        store.checkIndex(list, args[1] | 0, 'vec_get');
        return list[args[1] | 0];
      }
      case HOST.vec_set: {
        const list = store.vec(args[0]);
        store.checkIndex(list, args[1] | 0, 'vec_set');
        list[args[1] | 0] = args[2] | 0;
        return 0;
      }
      case HOST.vec_len: return store.vec(args[0]).length;
      case HOST.vec_clear: store.vec(args[0]).length = 0; return 0;

      /* ---- map ---- */
      case HOST.map_new: return store.mapNew();
      case HOST.map_set: store.map(args[0]).set(args[1], args[2] | 0); return 0;
      case HOST.map_get: return store.map(args[0]).get(args[1], args[2] | 0);
      case HOST.map_has: return store.map(args[0]).has(args[1]) ? 1 : 0;
      case HOST.map_del: store.map(args[0]).delete(args[1]); return 0;
      case HOST.map_len: return store.map(args[0]).size;

      /* ---- ring ---- */
      case HOST.ring_new: return store.ringNew();
      case HOST.ring_push: store.ring(args[0]).push(args[1] | 0); return 0;
      case HOST.ring_pop: {
        const queue = store.ring(args[0]);
        if (!queue.length) throw new HostRuntimeError('ring_pop 在空的队列上');
        return queue.shift() as number;
      }
      case HOST.ring_peek: {
        const queue = store.ring(args[0]);
        if (!queue.length) throw new HostRuntimeError('ring_peek 在空的队列上');
        return queue[0];
      }
      case HOST.ring_len: return store.ring(args[0]).length;

      default:
        throw new HostRuntimeError(`不认识的宿主调用编号 ${fn}`);
    }
  }
}

/**
 * printf 的格式串。
 *
 * 支持 `%d` / `%u` / `%f` / `%g` / `%x` / `%%`，够打调试信息了。
 * 和 C 一样：**格式串决定怎么解释这个数**，寄存器里存的只是一个数。
 * 宽度与精度只认 `%.Nf` 这一种，别的原样输出而不是猜。
 */
export function formatPrintf(format: string, values: number[]): string {
  let out = '';
  let index = 0;
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%') { out += format[i]; continue; }

    const match = /^%(?:\.(\d+))?([dufgx%])/.exec(format.slice(i));
    if (!match) { out += format[i]; continue; }
    i += match[0].length - 1;

    if (match[2] === '%') { out += '%'; continue; }
    const value = values[index] ?? 0;
    index += 1;
    switch (match[2]) {
      case 'd': out += String(value | 0); break;
      case 'u': out += String(value >>> 0); break;
      case 'x': out += (value >>> 0).toString(16); break;
      case 'f': out += value.toFixed(match[1] !== undefined ? Number(match[1]) : 6); break;
      case 'g': out += String(Number(value.toPrecision(6))); break;
      default: break;
    }
  }
  return out;
}
