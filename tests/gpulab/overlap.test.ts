/**
 * 通信与计算的重叠
 *
 * 重叠率的判据是**结构性的**：发起集合操作时，别的流上还有没有
 * 没同步过的 kernel。这套用例把这个判据的边界钉住 ——
 * 尤其是"同步过了就不算"和"同一个流上不算"。
 */
import { Cluster, SINGLE_NODE_8, compileProgram, runClusterHost } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

const KERNELS = `
__global__ void work(float* a, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = a[i] * 1.0009765625f;
}
`;

async function run(body: string, devices = 4) {
  const cluster = new Cluster({
    spec: { ...SINGLE_NODE_8, devices }, globalBytes: 1024 * 1024,
  });
  const program = await compileProgram(
    `${KERNELS}\n#include "cluster.h"\n#include "nccl.h"\n#include "cuda_runtime.h"\n${body}`
  );
  runClusterHost(cluster, program.host!, program.kernels);
  return cluster;
}

const SETUP = `
  const int N = 4;
  const int COUNT = 64;
  int devs[8]; for (int d = 0; d < N; ++d) devs[d] = d;
  int comms[8]; ncclCommInitAll(comms, N, devs);
  int send[8]; int recv[8]; int other[8];
  for (int d = 0; d < N; ++d) {
    cudaSetDevice(d);
    float* s; float* r; float* o;
    cudaMalloc((void**)&s, COUNT * 4);
    cudaMalloc((void**)&r, COUNT * 4);
    cudaMalloc((void**)&o, COUNT * 4);
    send[d] = s; recv[d] = r; other[d] = o;
  }
`;

describe('重叠率', () => {
  it('通信前什么计算都没发 —— 重叠率 0', async () => {
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBe(0);
  });

  it('**别的流上有计算在飞 —— 重叠率 1**', async () => {
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        int stream;
        cudaStreamCreate(&stream);
        for (int d = 0; d < N; ++d) {
          cudaSetDevice(d);
          work<<<1, 64, 0, stream>>>(other[d], COUNT);
        }
        // 计算还挂在 stream 上没同步，这时发通信 —— 重叠
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        cudaStreamSynchronize(stream);
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBe(1);
  });

  it('先同步再通信 —— 不算重叠', async () => {
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        int stream;
        cudaStreamCreate(&stream);
        for (int d = 0; d < N; ++d) {
          cudaSetDevice(d);
          work<<<1, 64, 0, stream>>>(other[d], COUNT);
        }
        cudaStreamSynchronize(stream);   // 等完了才发
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBe(0);
  });

  it('**计算和通信在同一个流上 —— 不算重叠**', async () => {
    // 真卡上同一个流是严格串行的，这是最常见的"以为重叠了其实没有"
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        for (int d = 0; d < N; ++d) {
          cudaSetDevice(d);
          work<<<1, 64, 0, 0>>>(other[d], COUNT);
        }
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBe(0);
  });

  it('一半重叠一半不重叠', async () => {
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        int stream;
        cudaStreamCreate(&stream);
        // 第一次：没有计算在飞
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        // 第二次：有
        for (int d = 0; d < N; ++d) {
          cudaSetDevice(d);
          work<<<1, 64, 0, stream>>>(other[d], COUNT);
        }
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBeCloseTo(0.5, 6);
  });

  it('cudaDeviceSynchronize 也会清掉在飞的计算', async () => {
    const cluster = await run(`
      int main(void) {
        ${SETUP}
        int stream;
        cudaStreamCreate(&stream);
        for (int d = 0; d < N; ++d) {
          cudaSetDevice(d);
          work<<<1, 64, 0, stream>>>(other[d], COUNT);
        }
        cudaDeviceSynchronize();
        ncclGroupStart();
        for (int d = 0; d < N; ++d) {
          ncclAllReduce(send[d], recv[d], COUNT, ncclFloat, ncclSum, comms[d], 0);
        }
        ncclGroupEnd();
        return 0;
      }
    `);
    expect(cluster.comm.overlapRatio).toBe(0);
  });
});

describe('流的语法', () => {
  it('第三个参数必须写 0 —— 动态共享内存还不支持', async () => {
    await expect(compileProgram(`
      ${KERNELS}
      int main(void) { work<<<1, 64, 4096, 0>>>(0, 1); return 0; }
    `)).rejects.toThrow(/动态共享内存/);
  });

  it('只写三个参数会说清该怎么写', async () => {
    await expect(compileProgram(`
      ${KERNELS}
      int main(void) { work<<<1, 64, 0>>>(0, 1); return 0; }
    `)).rejects.toThrow(/<<<grid, block, 0, stream>>>/);
  });
});
