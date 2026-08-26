/**
 * 在一个集群上跑宿主程序
 *
 * 单卡版是 `GpuDevice.runHost`；这里是多卡版。区别只在
 * `HostEnvironment` 的实现：分配、拷贝、起 kernel 都要先问"哪张卡"，
 * 并且多出 NCCL 那一套。
 */
import { HostRuntime, type HostEnvironment } from '../host/runtime';
import { HostRuntimeError } from '../host/containers';
import type { ExecutableKernel } from '../ir/program';
import { LinearMemory } from '../vm/memory';
import { dim3, launchKernel } from '../vm/vm';
import { DEVICE_SPAN, type Cluster } from './cluster';
import {
  BUS_FACTOR, redOpOf, ringAllGather, ringAllReduce, ringReduceScatter,
  treeBroadcast, treeReduce,
} from './nccl';

export interface ClusterRunResult {
  stdout: string;
}

export function runClusterHost(
  cluster: Cluster,
  host: ExecutableKernel,
  kernels: Map<string, ExecutableKernel>,
  buffers: Array<{ address: number; length: number }> = []
): ClusterRunResult {
  const output: string[] = [];
  const hostLocal = new LinearMemory(Math.max(64, host.localBytes), 'local');
  /** 这一轮里最大的一次集合操作的载荷，用来算 busbw */
  let payload = 0;
  let factorKind = 'allreduce';

  const environment: HostEnvironment = {
    cudaMalloc: (bytes) => cluster.malloc(bytes),
    cudaFree: () => {},
    copy: (dst, src, bytes, kind) => {
      // 主机端 = 宿主线程的 local 空间；设备端 = 某张卡的显存
      if (kind === 1) {                       // HostToDevice
        const local = cluster.localAddress(dst, deviceOf(dst), 'cudaMemcpy 的目标');
        const target = cluster.devices[deviceOf(dst)].memory;
        new Uint8Array(target.bytes, local, bytes)
          .set(new Uint8Array(hostLocal.bytes, src, bytes));
        return;
      }
      if (kind === 2) {                       // DeviceToHost
        const local = cluster.localAddress(src, deviceOf(src), 'cudaMemcpy 的来源');
        const source = cluster.devices[deviceOf(src)].memory;
        new Uint8Array(hostLocal.bytes, dst, bytes)
          .set(new Uint8Array(source.bytes, local, bytes));
        return;
      }
      if (kind === 0) {                       // HostToHost
        new Uint8Array(hostLocal.bytes, dst, bytes)
          .set(new Uint8Array(hostLocal.bytes, src, bytes));
        return;
      }
      // DeviceToDevice。**跨卡的 DeviceToDevice 要明确拒绝** ——
      // 真 CUDA 需要 cudaMemcpyPeer，混用会静默读到别的卡上的东西
      cluster.peerCopy(dst, deviceOf(dst), src, deviceOf(src), bytes);
    },
    memset: (address, value, bytes) => {
      const device = deviceOf(address);
      const local = cluster.localAddress(address, device, 'cudaMemset');
      new Uint8Array(cluster.devices[device].memory.bytes, local, bytes).fill(value & 0xff);
    },
    launch: (name, grid, block, args, line) => {
      const kernel = kernels.get(name);
      if (!kernel) {
        throw new HostRuntimeError(
          `第 ${line} 行：找不到 kernel \`${name}\` —— 编出来的有：${[...kernels.keys()].join(', ')}`
        );
      }
      cluster.launch(name, kernel, { grid, block }, args);
    },
    replay: () => {
      throw new HostRuntimeError('集群关卡还不支持 CUDA Graph');
    },
    write: (text) => { output.push(text); },
    buffer: (index) => {
      const found = buffers[index];
      if (!found) {
        throw new HostRuntimeError(
          `没有第 ${index} 号缓冲区 —— 这一关声明了 ${buffers.length} 个（编号从 0 开始）`
        );
      }
      return found;
    },

    deviceCount: () => cluster.count,
    getDevice: () => cluster.current,
    setDevice: (index) => cluster.setDevice(index),
    peerCopy: (dst, dstDevice, src, srcDevice, bytes) => {
      cluster.peerCopy(dst, dstDevice, src, srcDevice, bytes);
    },
    writeHostInts: (address, values) => {
      const view = new Int32Array(hostLocal.bytes, address, values.length);
      for (let i = 0; i < values.length; i += 1) view[i] = values[i] | 0;
    },
    readHostInts: (address, count) => (
      Array.from(new Int32Array(hostLocal.bytes, address, count))
    ),
    collective: (kind, ranks, count, op, root) => {
      // 环按**实际的卡**走，不是按 rank 号 —— 一个组摊在两台机器上时，
      // 环上就会有跨机的边，`comm.bytesByLink.ib` 立刻暴增
      const sorted = ranks.slice().sort((a, b) => a.device - b.device);
      if (sorted.length < 1) return;
      const seen = new Set<number>();
      for (const rank of sorted) {
        if (seen.has(rank.device)) {
          throw new HostRuntimeError(`${kind}：设备 ${rank.device} 在同一个 group 里出现了两次`);
        }
        seen.add(rank.device);
      }
      const reduce = redOpOf(op);
      switch (kind) {
        case 'allreduce': ringAllReduce(cluster, sorted, count, reduce); break;
        case 'allgather': ringAllGather(cluster, sorted, count); break;
        case 'reducescatter': ringReduceScatter(cluster, sorted, count, reduce); break;
        case 'broadcast': treeBroadcast(cluster, sorted, count, Math.max(0, root)); break;
        case 'reduce': treeReduce(cluster, sorted, count, Math.max(0, root), reduce); break;
        default: throw new HostRuntimeError(`不认识的集合操作 ${kind}`);
      }
      const bytes = count * 4 * (kind === 'reducescatter' ? sorted.length : 1);
      if (bytes > payload) { payload = bytes; factorKind = kind; }
    },
  };

  function deviceOf(address: number): number {
    // 地址自带设备号，见 cluster.ts 开头
    return Math.floor(address / DEVICE_SPAN) - 1;
  }

  const runtime = new HostRuntime(environment, host.strings ?? []);
  launchKernel(host, { grid: dim3(1), block: dim3(1) }, [], {
    memory: cluster.devices[0].memory,
    host: runtime,
    localMemory: hostLocal,
  });

  const factor = BUS_FACTOR[factorKind] ?? (() => 1);
  cluster.finishBandwidth(payload, factor(cluster.count));
  return { stdout: output.join('') };
}
