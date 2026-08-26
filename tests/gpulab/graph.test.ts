/**
 * CUDA Graph
 *
 * 这套用例钉住两件事：**省下来的是提交次数、不是计算量**，
 * 以及**录下来的标量是捕获那一刻的值**（学员最容易在这里翻车，
 * 而且翻得很安静 —— 结果不对但程序照跑）。
 */
import { GpuDevice, compileProgram } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

const KERNELS = `
__global__ void addOne(float* a, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = a[i] + 1.0f;
}
__global__ void addPtr(float* a, const int* howMany, int n) {
  int i = threadIdx.x;
  if (i < n) a[i] = a[i] + (float)howMany[0];
}
`;

async function run(source: string, length = 8) {
  const program = await compileProgram(`${KERNELS}\n#include "engine.h"\n${source}`);
  const gpu = new GpuDevice({ globalBytes: 1024 * 1024 });
  const address = gpu.malloc(length * 4);
  gpu.copyIn(address, new Float32Array(length));
  const result = gpu.runHost(program.host!, program.kernels, [{ address, length }]);
  return { gpu, out: gpu.copyOut(address, length), stdout: result.stdout };
}

describe('捕获与重放', () => {
  it('重放跑的是真的活，只是提交次数变成一次', async () => {
    const { gpu, out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        addOne<<<1, 8>>>(a, 8);
        addOne<<<1, 8>>>(a, 8);
        addOne<<<1, 8>>>(a, 8);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);
        cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    // 三个 kernel 都跑了
    expect(Array.from(out.slice(0, 3))).toEqual([3, 3, 3]);
    // 但只提交了一次
    expect(gpu.metrics().launch.kernels).toBe(1);
    // block 数照旧是三个 —— 计算量一点没少
    expect(gpu.metrics().launch.blocks).toBe(3);
  });

  it('**捕获期间 kernel 不执行**', async () => {
    const { out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph;
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        addOne<<<1, 8>>>(a, 8);
        cudaStreamEndCapture(0, &graph);
        return 0;
      }
    `);
    expect(out[0]).toBe(0);
  });

  it('同一张 graph 重放多次，每次都是完整的一遍', async () => {
    const { gpu, out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        addOne<<<1, 8>>>(a, 8);
        addOne<<<1, 8>>>(a, 8);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);
        for (int i = 0; i < 5; ++i) cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    expect(out[0]).toBe(10);
    // 5 次重放 = 5 次提交，而不是 10 次
    expect(gpu.metrics().launch.kernels).toBe(5);
    expect(gpu.metrics().launch.blocks).toBe(10);
  });

  it('不用 graph 的话，同样的活要提交 10 次', async () => {
    const { gpu, out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        for (int i = 0; i < 5; ++i) {
          addOne<<<1, 8>>>(a, 8);
          addOne<<<1, 8>>>(a, 8);
        }
        return 0;
      }
    `);
    expect(out[0]).toBe(10);
    expect(gpu.metrics().launch.kernels).toBe(10);
    expect(gpu.metrics().launch.blocks).toBe(10);
  });
});

describe('捕获录下来的是那一刻的实参', () => {
  it('**按值传的标量会被定死** —— 这是 graph 最容易翻的地方', async () => {
    const { out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        int n = 2;
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        addOne<<<1, 8>>>(a, n);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);
        n = 8;                    // 改了也没用：录的是捕获时的 2
        cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(1);
    // 第 2..7 个没被碰 —— n 还是捕获时的 2
    expect(out[2]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('把会变的量放进显存，重放就跟着变 —— 真实引擎的解法', async () => {
    const { out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        int* howMany;
        cudaMalloc((void**)&howMany, 4);

        int host[1];
        host[0] = 10;
        cudaMemcpy(howMany, host, 4, cudaMemcpyHostToDevice);

        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        addPtr<<<1, 8>>>(a, howMany, 8);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);

        cudaGraphLaunch(exec, 0);
        host[0] = 100;
        cudaMemcpy(howMany, host, 4, cudaMemcpyHostToDevice);
        cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    // 指针稳定，指向的内容变了，于是两次重放加的不是同一个数
    expect(out[0]).toBe(110);
  });
});

describe('边界', () => {
  it('没捕获就结束会报错', async () => {
    await expect(run(`
      int main(void) { int g; cudaStreamEndCapture(0, &g); return 0; }
    `)).rejects.toThrow(/没有在捕获/);
  });

  it('捕获不能嵌套', async () => {
    await expect(run(`
      int main(void) {
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        return 0;
      }
    `)).rejects.toThrow(/不能嵌套/);
  });

  it('没实例化就重放会说清楚', async () => {
    await expect(run(`
      int main(void) { int exec; exec = 0; cudaGraphLaunch(exec, 0); return 0; }
    `)).rejects.toThrow(/还没被 cudaGraphInstantiate 填上/);
  });

  it('出参必须写成 &变量', async () => {
    await expect(compileProgram(`
      int main(void) { int g; cudaStreamEndCapture(0, g); return 0; }
    `)).rejects.toThrow(/&变量/);
  });
});

describe('拷贝也进 graph', () => {
  it('**捕获期间的 cudaMemcpy 不立即执行，重放时才做**', async () => {
    const { out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        float host[4];
        host[0] = 7.0f; host[1] = 7.0f; host[2] = 7.0f; host[3] = 7.0f;

        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        cudaMemcpy(a, host, 16, cudaMemcpyHostToDevice);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);

        // 捕获期间没执行，所以这里还是 0
        if (a[0] > 0.0f) { printf("bad\n"); }
        cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    expect(out[0]).toBe(7);
  });

  it('拷贝与 kernel 在 graph 里按录入顺序执行', async () => {
    const { gpu, out } = await run(`
      int main(void) {
        float* a = lab_buffer(0);
        int graph; int exec;
        float host[4];
        host[0] = 5.0f; host[1] = 5.0f; host[2] = 5.0f; host[3] = 5.0f;

        cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
        cudaMemcpy(a, host, 16, cudaMemcpyHostToDevice);
        addOne<<<1, 8>>>(a, 4);
        cudaStreamEndCapture(0, &graph);
        cudaGraphInstantiate(&exec, graph, 0);
        cudaGraphLaunch(exec, 0);
        cudaGraphLaunch(exec, 0);
        return 0;
      }
    `);
    // 每次重放都先拷回 5 再加 1，所以两次之后仍然是 6 而不是 7
    expect(out[0]).toBe(6);
    expect(gpu.metrics().launch.kernels).toBe(2);
  });
});
