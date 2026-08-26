/**
 * 集群
 *
 * 这套用例钉住三件事：
 *  1. **一张卡的指针在另一张卡上是非法的**，而且报错说得清是哪张卡的；
 *  2. 通信计量（字节、消息、按链路分）是精确的；
 *  3. ring all-reduce 走的是真的 `2(n-1)` 步，于是 `2(n-1)/n` 那个
 *     修正因子是数出来的。
 */
import {
  Cluster, SINGLE_NODE_8, TWO_NODE_16, compileProgram, runClusterHost,
} from '../../src/lib/gpulab';

jest.setTimeout(180_000);

const KERNELS = `
__global__ void fill(float* a, float value, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = value;
}
__global__ void addInto(float* a, const float* b, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = a[i] + b[i];
}
`;

async function run(source: string, devices = 4, spec = SINGLE_NODE_8) {
  const cluster = new Cluster({
    spec: { ...spec, devices },
    globalBytes: 1024 * 1024,
  });
  const program = await compileProgram(`${KERNELS}\n#include "cluster.h"\n#include "nccl.h"\n${source}`);
  const result = runClusterHost(cluster, program.host!, program.kernels);
  return { cluster, stdout: result.stdout };
}

describe('地址空间是分开的', () => {
  it('每张卡自己分配、自己算', async () => {
    const { cluster, stdout } = await run(`
      int main(void) {
        int n;
        cudaGetDeviceCount(&n);
        printf("devices=%d\\n", n);
        for (int d = 0; d < n; ++d) {
          cudaSetDevice(d);
          float* a;
          cudaMalloc((void**)&a, 32);
          fill<<<1, 8>>>(a, (float)(d + 1), 8);
        }
        return 0;
      }
    `);
    expect(stdout).toBe('devices=4\n');
    // 四张卡各起了一次
    for (let d = 0; d < 4; d += 1) {
      expect(cluster.devices[d].metrics().launch.blocks).toBe(1);
    }
  });

  it('**拿别的卡的指针去起 kernel 会报错，并且说清是哪张卡的**', async () => {
    await expect(run(`
      int main(void) {
        cudaSetDevice(0);
        float* a;
        cudaMalloc((void**)&a, 32);
        cudaSetDevice(1);
        fill<<<1, 8>>>(a, 1.0f, 8);      // a 是设备 0 的
        return 0;
      }
    `)).rejects.toThrow(/设备 0 的指针，却在设备 1 上用/);
  });

  it('cudaMemcpyPeer 才是跨卡搬数据的办法', async () => {
    const { cluster } = await run(`
      int main(void) {
        cudaSetDevice(0);
        float* a;
        cudaMalloc((void**)&a, 32);
        fill<<<1, 8>>>(a, 3.0f, 8);

        cudaSetDevice(1);
        float* b;
        cudaMalloc((void**)&b, 32);
        cudaMemcpyPeer(b, 1, a, 0, 32);
        return 0;
      }
    `);
    expect(cluster.comm.bytes).toBe(32);
    expect(cluster.comm.messages).toBe(1);
    // 同一台机器里，走 NVLink
    expect(cluster.comm.bytesByLink.nvlink).toBe(32);
    expect(cluster.comm.bytesByLink.ib).toBe(0);
  });

  it('设备号越界会说清一共几张卡', async () => {
    await expect(run(`
      int main(void) { cudaSetDevice(9); return 0; }
    `)).rejects.toThrow(/一共 4 张卡/);
  });
});

describe('链路选择', () => {
  it('**跨机的流量走 IB，不是 NVLink** —— 张量并行跨机就是被这条抓住的', async () => {
    const { cluster } = await run(`
      int main(void) {
        cudaSetDevice(0);
        float* a; cudaMalloc((void**)&a, 64);
        cudaSetDevice(8);
        float* b; cudaMalloc((void**)&b, 64);
        cudaMemcpyPeer(b, 8, a, 0, 64);
        return 0;
      }
    `, 16, TWO_NODE_16);
    // 设备 0 在节点 0，设备 8 在节点 1
    expect(cluster.comm.bytesByLink.ib).toBe(64);
    expect(cluster.comm.bytesByLink.nvlink).toBe(0);
  });

  it('机内还是走 NVLink', async () => {
    const { cluster } = await run(`
      int main(void) {
        cudaSetDevice(0);
        float* a; cudaMalloc((void**)&a, 64);
        cudaSetDevice(7);
        float* b; cudaMalloc((void**)&b, 64);
        cudaMemcpyPeer(b, 7, a, 0, 64);
        return 0;
      }
    `, 16, TWO_NODE_16);
    expect(cluster.comm.bytesByLink.nvlink).toBe(64);
    expect(cluster.comm.bytesByLink.ib).toBe(0);
  });
});

describe('NCCL', () => {
  const ALLREDUCE = (n: number) => `
    int main(void) {
      const int N = 16;
      int comms[8];
      ncclCommInitAll(comms, ${n}, 0);
      int send[8]; int recv[8];
      for (int d = 0; d < ${n}; ++d) {
        cudaSetDevice(d);
        float* s; float* r;
        cudaMalloc((void**)&s, N * 4);
        cudaMalloc((void**)&r, N * 4);
        fill<<<1, 16>>>(s, (float)(d + 1), N);
        send[d] = s; recv[d] = r;
      }
      ncclGroupStart();
      for (int d = 0; d < ${n}; ++d) {
        ncclAllReduce(send[d], recv[d], N, ncclFloat, ncclSum, comms[d], 0);
      }
      ncclGroupEnd();
      // recv[d] 里存的是**地址**，要拷回宿主才能打印
      float host[4];
      for (int d = 0; d < ${n}; ++d) {
        cudaSetDevice(d);
        cudaMemcpy(host, recv[d], 4, cudaMemcpyDeviceToHost);
        printf("%.1f ", host[0]);
      }
      printf("\\n");
      return 0;
    }
  `;

  it('all-reduce 之后人人拿到同一个和', async () => {
    const { stdout } = await run(ALLREDUCE(4), 4);
    // 1 + 2 + 3 + 4 = 10，四张卡都是 10
    expect(stdout).toBe('10.0 10.0 10.0 10.0 \n');
  });

  it('**走的是真的 ring：2(n-1) 步**', async () => {
    const { cluster } = await run(ALLREDUCE(4), 4);
    const n = 4;
    // 每一步每张卡发一次，一共 2(n-1) 步 × n 张卡
    expect(cluster.comm.messages).toBe(2 * (n - 1) * n);
    // 每张卡搬的总量 = 2(n-1)/n × 缓冲区大小
    const payload = 16 * 4;
    expect(cluster.comm.bytes).toBe(2 * (n - 1) * n * (payload / n));
  });

  it('busbw 的修正因子是 2(n-1)/n', async () => {
    const { cluster } = await run(ALLREDUCE(4), 4);
    const ratio = cluster.comm.busbw / cluster.comm.algbw;
    expect(ratio).toBeCloseTo((2 * (4 - 1)) / 4, 6);
  });

  it('**不成组会报错，而不是死锁或跑出个看似正常的结果**', async () => {
    await expect(run(`
      int main(void) {
        int comms[8];
        ncclCommInitAll(comms, 2, 0);
        int send[8]; int recv[8];
        for (int d = 0; d < 2; ++d) {
          cudaSetDevice(d);
          float* s; float* r;
          cudaMalloc((void**)&s, 64); cudaMalloc((void**)&r, 64);
          send[d] = s; recv[d] = r;
        }
        ncclAllReduce(send[0], recv[0], 16, ncclFloat, ncclSum, comms[0], 0);
        return 0;
      }
    `, 2)).rejects.toThrow(/ncclGroupStart/);
  });

  it('all-gather 把每张卡的那一份拼起来', async () => {
    const { stdout } = await run(`
      int main(void) {
        const int N = 4;
        int comms[8];
        ncclCommInitAll(comms, 4, 0);
        int send[8]; int recv[8];
        for (int d = 0; d < 4; ++d) {
          cudaSetDevice(d);
          float* s; float* r;
          cudaMalloc((void**)&s, N * 4);
          cudaMalloc((void**)&r, N * 4 * 4);
          fill<<<1, 4>>>(s, (float)(d + 1), N);
          send[d] = s; recv[d] = r;
        }
        ncclGroupStart();
        for (int d = 0; d < 4; ++d) {
          ncclAllGather(send[d], recv[d], N, ncclFloat, comms[d], 0);
        }
        ncclGroupEnd();
        cudaSetDevice(2);
        float host[16];
        cudaMemcpy(host, recv[2], 16 * 4, cudaMemcpyDeviceToHost);
        printf("%.0f %.0f %.0f\\n", host[0], host[4], host[8]);
        return 0;
      }
    `, 4);
    // 四张卡各贡献 4 个元素，拼起来是 1 1 1 1 2 2 2 2 3 3 3 3 4 4 4 4
    expect(stdout).toBe('1 2 3\n');
  });

  it('reduce-scatter：归约之后每张卡只拿自己那 1/n', async () => {
    const { cluster } = await run(`
      int main(void) {
        const int PER = 4;
        int comms[8];
        ncclCommInitAll(comms, 4, 0);
        int send[8]; int recv[8];
        for (int d = 0; d < 4; ++d) {
          cudaSetDevice(d);
          float* s; float* r;
          cudaMalloc((void**)&s, PER * 4 * 4);
          cudaMalloc((void**)&r, PER * 4);
          fill<<<1, 16>>>(s, (float)(d + 1), PER * 4);
          send[d] = s; recv[d] = r;
        }
        ncclGroupStart();
        for (int d = 0; d < 4; ++d) {
          ncclReduceScatter(send[d], recv[d], PER, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `, 4);
    // reduce-scatter 每张卡搬 (n-1) × recvCount，比 all-reduce 少一半
    expect(cluster.comm.messages).toBe(3 * 4);
  });
});

describe('确定性', () => {
  it('多卡的 all-reduce 跑 10 遍逐位相同', async () => {
    const source = `
      int main(void) {
        const int N = 32;
        int comms[8];
        ncclCommInitAll(comms, 4, 0);
        int send[8]; int recv[8];
        for (int d = 0; d < 4; ++d) {
          cudaSetDevice(d);
          float* s; float* r;
          cudaMalloc((void**)&s, N * 4); cudaMalloc((void**)&r, N * 4);
          fill<<<1, 32>>>(s, 0.1f * (float)(d + 1), N);
          send[d] = s; recv[d] = r;
        }
        ncclGroupStart();
        for (int d = 0; d < 4; ++d) {
          ncclAllReduce(send[d], recv[d], N, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        float host[1];
        cudaSetDevice(0);
        cudaMemcpy(host, recv[0], 4, cudaMemcpyDeviceToHost);
        printf("%.9f\\n", host[0]);
        return 0;
      }
    `;
    const first = await run(source, 4);
    for (let i = 0; i < 10; i += 1) {
      const again = await run(source, 4);
      expect(again.stdout).toBe(first.stdout);
      expect(again.cluster.comm.bytes).toBe(first.cluster.comm.bytes);
    }
  });
});
