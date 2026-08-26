/**
 * NCCL 集合通信
 *
 * ## 算法是真做的
 *
 * `ncclAllReduce` 不是「把数加起来然后填回去」这么一句。它按 **ring 算法**
 * 真的走 `2(n-1)` 步、真的记每一步走了哪条链路 —— 于是
 * `comm.bytes` 与 `busbw` 是数出来的，不是套公式算的。
 *
 * 第 22 关让学员自己用 p2p 拼一个 ring all-reduce，第 23 关换成 NCCL：
 * 那时候 `2(n-1)/n` 这个修正因子对他来说是**数出来的步数**，
 * 不是一个背下来的公式。这是这两关分开做的全部理由。
 *
 * ## 归约的顺序是定死的
 *
 * 浮点加法不满足结合律，所以归约顺序不同结果就不同。
 * ring 算法的顺序是确定的（按 rank 依次累加），我们照着做，
 * 于是**重放逐位一致**这条硬承诺在多卡上依然成立。
 * 真 NCCL 也是这个性质：同样的通信子、同样的规模，结果可复现。
 */
import type { Cluster } from './cluster';

export type RedOp = 'sum' | 'prod' | 'max' | 'min';

export function redOpOf(code: number): RedOp {
  switch (code) {
    case 1: return 'prod';
    case 2: return 'max';
    case 3: return 'min';
    default: return 'sum';
  }
}

function combine(a: number, b: number, op: RedOp): number {
  switch (op) {
    case 'prod': return Math.fround(a * b);
    case 'max': return Math.max(a, b);
    case 'min': return Math.min(a, b);
    default: return Math.fround(a + b);
  }
}

/** 一次集合操作里，每个 rank 的收发缓冲区 */
export interface CommBuffers {
  send: number;
  recv: number;
}

/**
 * ring all-reduce。
 *
 * 分两个阶段，每个阶段 n-1 步：
 *   1. **reduce-scatter**：每张卡最后持有 1/n 的完整归约结果
 *   2. **all-gather**：把这 n 份结果转一圈，人人拿全
 *
 * 一共 `2(n-1)` 步，每步搬 `count/n` 个元素。
 * 每张卡搬的总量是 `2(n-1)/n × 缓冲区大小` ——
 * **这就是 busbw 那个修正因子的来历**。
 */
export function ringAllReduce(
  cluster: Cluster, buffers: CommBuffers[], count: number, op: RedOp
): void {
  const n = buffers.length;
  if (n === 1) {
    copyWithin(cluster, buffers[0].recv, buffers[0].send, count);
    return;
  }

  // 先把 send 拷进 recv，之后全在 recv 上原地做 —— 真 NCCL 也允许原地
  const data: Float32Array[] = [];
  for (let rank = 0; rank < n; rank += 1) {
    data.push(cluster.copyOut(buffers[rank].send, count));
  }

  const chunk = Math.ceil(count / n);
  const range = (index: number) => {
    const start = Math.min(index * chunk, count);
    return { start, end: Math.min(start + chunk, count) };
  };

  // 阶段一：reduce-scatter
  for (let step = 0; step < n - 1; step += 1) {
    const pending: Array<{ rank: number; index: number; values: Float32Array }> = [];
    for (let rank = 0; rank < n; rank += 1) {
      const sendIndex = (rank - step + n) % n;
      const { start, end } = range(sendIndex);
      pending.push({
        rank: (rank + 1) % n,
        index: sendIndex,
        values: data[rank].slice(start, end),
      });
      cluster.account(rank, (rank + 1) % n, (end - start) * 4);
    }
    for (const item of pending) {
      const { start, end } = range(item.index);
      for (let i = start; i < end; i += 1) {
        data[item.rank][i] = combine(data[item.rank][i], item.values[i - start], op);
      }
    }
  }

  // 阶段二：all-gather。这时 rank r 持有第 (r + 1) % n 块的完整结果
  for (let step = 0; step < n - 1; step += 1) {
    const pending: Array<{ rank: number; index: number; values: Float32Array }> = [];
    for (let rank = 0; rank < n; rank += 1) {
      const sendIndex = (rank + 1 - step + n) % n;
      const { start, end } = range(sendIndex);
      pending.push({
        rank: (rank + 1) % n,
        index: sendIndex,
        values: data[rank].slice(start, end),
      });
      cluster.account(rank, (rank + 1) % n, (end - start) * 4);
    }
    for (const item of pending) {
      const { start, end } = range(item.index);
      for (let i = start; i < end; i += 1) data[item.rank][i] = item.values[i - start];
    }
  }

  for (let rank = 0; rank < n; rank += 1) cluster.copyIn(buffers[rank].recv, data[rank]);
}

/** all-gather：每张卡贡献 count 个元素，人人拿到 n × count */
export function ringAllGather(cluster: Cluster, buffers: CommBuffers[], count: number): void {
  const n = buffers.length;
  const parts: Float32Array[] = [];
  for (let rank = 0; rank < n; rank += 1) {
    parts.push(cluster.copyOut(buffers[rank].send, count));
  }
  for (let step = 0; step < n - 1; step += 1) {
    for (let rank = 0; rank < n; rank += 1) cluster.account(rank, (rank + 1) % n, count * 4);
  }
  const all = new Float32Array(n * count);
  for (let rank = 0; rank < n; rank += 1) all.set(parts[rank], rank * count);
  for (let rank = 0; rank < n; rank += 1) cluster.copyIn(buffers[rank].recv, all);
}

/** reduce-scatter：归约之后每张卡只拿自己那 1/n */
export function ringReduceScatter(
  cluster: Cluster, buffers: CommBuffers[], recvCount: number, op: RedOp
): void {
  const n = buffers.length;
  const total = recvCount * n;
  const data: Float32Array[] = [];
  for (let rank = 0; rank < n; rank += 1) {
    data.push(cluster.copyOut(buffers[rank].send, total));
  }
  for (let step = 0; step < n - 1; step += 1) {
    for (let rank = 0; rank < n; rank += 1) cluster.account(rank, (rank + 1) % n, recvCount * 4);
  }
  for (let rank = 0; rank < n; rank += 1) {
    const out = new Float32Array(recvCount);
    for (let i = 0; i < recvCount; i += 1) {
      // 归约顺序按 rank 从小到大，固定 —— 浮点加法不满足结合律，
      // 顺序一变结果就变，而我们承诺过重放逐位一致
      let acc = data[0][rank * recvCount + i];
      for (let other = 1; other < n; other += 1) {
        acc = combine(acc, data[other][rank * recvCount + i], op);
      }
      out[i] = acc;
    }
    cluster.copyIn(buffers[rank].recv, out);
  }
}

/** broadcast：root 的内容发给所有人。用二叉树，log(n) 步 */
export function treeBroadcast(
  cluster: Cluster, buffers: CommBuffers[], count: number, root: number
): void {
  const n = buffers.length;
  const values = cluster.copyOut(buffers[root].send, count);
  // 二叉树：第 k 轮，已经拿到数据的卡各自发给一张没拿到的
  const have = [root];
  while (have.length < n) {
    const wave = have.slice();
    for (const source of wave) {
      if (have.length >= n) break;
      let target = -1;
      for (let candidate = 0; candidate < n; candidate += 1) {
        if (!have.includes(candidate)) { target = candidate; break; }
      }
      if (target < 0) break;
      cluster.account(source, target, count * 4);
      have.push(target);
    }
  }
  for (let rank = 0; rank < n; rank += 1) cluster.copyIn(buffers[rank].recv, values);
}

/** reduce：归约到 root 一张卡上 */
export function treeReduce(
  cluster: Cluster, buffers: CommBuffers[], count: number, root: number, op: RedOp
): void {
  const n = buffers.length;
  const data: Float32Array[] = [];
  for (let rank = 0; rank < n; rank += 1) data.push(cluster.copyOut(buffers[rank].send, count));
  for (let rank = 0; rank < n; rank += 1) {
    if (rank !== root) cluster.account(rank, root, count * 4);
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let acc = data[0][i];
    for (let rank = 1; rank < n; rank += 1) acc = combine(acc, data[rank][i], op);
    out[i] = acc;
  }
  cluster.copyIn(buffers[root].recv, out);
}

function copyWithin(cluster: Cluster, dst: number, src: number, count: number): void {
  if (dst === src) return;
  cluster.copyIn(dst, cluster.copyOut(src, count));
}

/**
 * 各个集合操作的 busbw 修正因子。
 *
 * 口径来自 nccl-tests 的 README：算法带宽换算成总线带宽时，
 * 每种操作在环上实际搬的总量与用户看到的字节数之比不同。
 */
export const BUS_FACTOR: Record<string, (n: number) => number> = {
  allreduce: (n) => (2 * (n - 1)) / n,
  allgather: (n) => (n - 1) / n,
  reducescatter: (n) => (n - 1) / n,
  broadcast: () => 1,
  reduce: () => 1,
};
