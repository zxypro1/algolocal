/**
 * 掉卡
 *
 * 真硬件上一张卡掉出总线之后，对它的所有调用都返回错误。
 * 这套用例钉住的是**不检查返回值就会崩** —— 那正是真实系统里
 * 会发生的事，模拟器不该替学员把它抹平。
 */
import { Cluster, SINGLE_NODE_8, compileProgram, runClusterHost } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

const KERNELS = `
__global__ void work(float* a, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = a[i] + 1.0f;
}
`;

async function run(body: string, devices = 4) {
  const cluster = new Cluster({ spec: { ...SINGLE_NODE_8, devices }, globalBytes: 1024 * 1024 });
  const program = await compileProgram(`${KERNELS}\n#include "cluster.h"\n${body}`);
  const out = runClusterHost(cluster, program.host!, program.kernels);
  return { cluster, stdout: out.stdout };
}

describe('掉卡', () => {
  it('**不检查 cudaSetDevice 的返回值就会崩**', async () => {
    await expect(run(`
      int main(void) {
        float* a;
        cudaSetDevice(1);
        cudaMalloc((void**)&a, 64);
        lab_fail_device(1);
        cudaSetDevice(1);          // 返回非零，但没人看
        work<<<1, 16>>>(a, 16);    // 崩在这
        return 0;
      }
    `)).rejects.toThrow(/已经掉线了/);
  });

  it('cudaSetDevice 对掉线的卡返回非零，而且不改变当前设备', async () => {
    const { stdout } = await run(`
      int main(void) {
        cudaSetDevice(0);
        lab_fail_device(2);
        int rc = cudaSetDevice(2);
        int now;
        cudaGetDevice(&now);
        printf("rc=%d now=%d\\n", rc, now);
        return 0;
      }
    `);
    // 非零错误码，当前设备还停在 0
    expect(stdout).toBe('rc=46 now=0\n');
  });

  it('检查了返回值就能绕开', async () => {
    const { cluster, stdout } = await run(`
      int main(void) {
        int buf[4];
        for (int d = 0; d < 4; ++d) {
          cudaSetDevice(d);
          float* a; cudaMalloc((void**)&a, 64);
          buf[d] = a;
        }
        lab_fail_device(2);
        int done = 0;
        for (int d = 0; d < 4; ++d) {
          if (cudaSetDevice(d) != 0) { continue; }
          work<<<1, 16>>>(buf[d], 16);
          done += 1;
        }
        printf("done=%d\\n", done);
        return 0;
      }
    `);
    expect(stdout).toBe('done=3\n');
    // 掉线那张卡一个 block 都没起
    expect(cluster.devices[2].metrics().launch.blocks).toBe(0);
  });

  it('跨卡拷贝碰到掉线的卡也会报错', async () => {
    await expect(run(`
      int main(void) {
        int buf[4];
        for (int d = 0; d < 2; ++d) {
          cudaSetDevice(d);
          float* a; cudaMalloc((void**)&a, 64);
          buf[d] = a;
        }
        lab_fail_device(1);
        cudaMemcpyPeer(buf[1], 1, buf[0], 0, 64);
        return 0;
      }
    `)).rejects.toThrow(/掉线/);
  });

  it('掉一张不存在的卡会说清一共几张', async () => {
    await expect(run(`
      int main(void) { lab_fail_device(9); return 0; }
    `)).rejects.toThrow(/一共 4 张卡/);
  });
});
