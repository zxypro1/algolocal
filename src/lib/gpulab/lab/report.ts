/**
 * Nsight Compute 样子的剖析报告
 *
 * 分节名与指标名**照抄 ncu**（见 design/gpulab.md 第七节的对照表）。
 * 这不是装样子：学员拿 `dram__bytes_read.sum` 这个名字去搜，搜到的是
 * NVIDIA 的文档而不是我们编的东西 —— 「接口真实」在剖析器上的具体含义
 * 就是这个。
 *
 * 数值来自我们的计数器。哪些精确、哪些是模型值，metrics.ts 的注释里
 * 逐条写了；这里只负责排版。
 */
import type { GpuMetrics, StaticMetrics } from '../metrics';
import type { DeviceSpec } from '../device';

interface Row {
  metric: string;
  unit: string;
  value: string;
}

function table(rows: Row[]): string[] {
  const widths = [
    Math.max(11, ...rows.map((row) => row.metric.length)),
    Math.max(11, ...rows.map((row) => row.unit.length)),
    Math.max(12, ...rows.map((row) => row.value.length)),
  ];
  const rule = widths.map((width) => '-'.repeat(width)).join(' ');
  const line = (a: string, b: string, c: string) =>
    `    ${a.padEnd(widths[0])} ${b.padEnd(widths[1])} ${c.padStart(widths[2])}`;

  return [
    line('Metric Name', 'Metric Unit', 'Metric Value'),
    `    ${rule}`,
    ...rows.map((row) => line(row.metric, row.unit, row.value)),
  ];
}

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString('en-US');
  return value.toFixed(digits);
}

/**
 * 一次 kernel 的完整剖析。
 *
 * 分节顺序和 ncu 的默认报告一致：Speed Of Light → Memory Workload →
 * Compute Workload → Occupancy → Warp State → Launch Statistics。
 */
export function formatProfile(input: {
  kernelName: string;
  signature: string;
  device: DeviceSpec;
  metrics: GpuMetrics;
  stat: StaticMetrics | null;
}): string {
  const { kernelName, signature, device, metrics, stat } = input;
  const lines: string[] = [];

  lines.push(`  ${kernelName}(${signature})`);
  lines.push(`    Section: GPU Speed Of Light Throughput`);
  lines.push(...table([
    { metric: 'DRAM Read Bytes', unit: 'byte', value: num(metrics.memory.readBytes) },
    { metric: 'DRAM Write Bytes', unit: 'byte', value: num(metrics.memory.writeBytes) },
    { metric: 'Arithmetic Intensity', unit: 'flop/byte', value: num(arithmeticIntensity(metrics)) },
  ]));
  lines.push('');

  lines.push(`    Section: Memory Workload Analysis`);
  lines.push(...table([
    { metric: 'dram__bytes_read.sum', unit: 'byte', value: num(metrics.memory.readBytes) },
    { metric: 'dram__bytes_write.sum', unit: 'byte', value: num(metrics.memory.writeBytes) },
    {
      metric: 'l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio',
      unit: 'sector/req',
      value: num(metrics.global.sectorsPerRequest, 2),
    },
    {
      metric: 'l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum',
      unit: '', value: num(metrics.shared.bankConflicts),
    },
    { metric: 'Local Memory Traffic', unit: 'byte', value: num(metrics.local.bytes) },
  ]));
  lines.push('');

  lines.push(`    Section: Compute Workload Analysis`);
  lines.push(...table([
    { metric: 'smsp__thread_inst_executed.sum', unit: 'inst', value: num(metrics.inst.laneExecuted) },
    { metric: 'sm__inst_executed.sum', unit: 'inst', value: num(metrics.inst.warpExecuted) },
    { metric: 'FMA Instructions', unit: 'inst', value: num(metrics.inst.fma) },
    { metric: 'Load/Store Instructions', unit: 'inst', value: num(metrics.inst.ldst) },
    { metric: 'Atomic Operations', unit: 'op', value: num(metrics.atomics) },
  ]));
  lines.push('');

  lines.push(`    Section: Occupancy`);
  lines.push(...table([
    {
      metric: 'Theoretical Occupancy', unit: '%',
      value: stat ? num(stat.occupancy.theoretical * 100, 1) : '—',
    },
    {
      metric: 'Theoretical Active Warps per SM', unit: 'warp',
      value: stat ? num(stat.occupancy.warpsPerSm) : '—',
    },
    {
      metric: 'Block Limit', unit: 'block',
      value: stat ? num(stat.occupancy.blocksPerSm) : '—',
    },
    {
      metric: 'launch__registers_per_thread', unit: 'register/thread',
      value: stat ? num(stat.registersPerThread) : '—',
    },
    {
      metric: 'launch__shared_mem_per_block_static', unit: 'byte/block',
      value: stat ? num(stat.sharedBytesPerBlock) : '—',
    },
  ]));
  if (stat && stat.occupancy.limiter !== 'none' && stat.occupancy.limiter !== 'warps') {
    lines.push('');
    lines.push(`    OPT   占用率被 ${limiterText(stat.occupancy.limiter)} 卡住了。`);
  }
  lines.push('');

  lines.push(`    Section: Warp State Statistics`);
  lines.push(...table([
    { metric: 'Warp Execution Efficiency', unit: '%', value: num(metrics.warp.activeLaneRatio * 100, 1) },
    { metric: 'Divergent Branches', unit: '', value: num(metrics.warp.divergentBranches) },
    { metric: 'Warp Shuffles', unit: 'inst', value: num(metrics.warp.shuffles) },
    { metric: 'Barriers', unit: '', value: num(metrics.launch.barriers) },
  ]));
  lines.push('');

  lines.push(`    Section: Launch Statistics`);
  lines.push(...table([
    { metric: 'Blocks Launched', unit: 'block', value: num(metrics.launch.blocks) },
    { metric: 'Warps Launched', unit: 'warp', value: num(metrics.launch.warps) },
    { metric: 'Device', unit: '', value: device.name },
  ]));

  return lines.join('\n');
}

function limiterText(limiter: StaticMetrics['occupancy']['limiter']): string {
  switch (limiter) {
    case 'registers': return '寄存器用量';
    case 'shared': return '共享内存用量';
    case 'blocks': return '每 SM 的 block 数上限';
    default: return '';
  }
}

/**
 * 算术强度：每从 DRAM 搬一个字节，做了多少次浮点运算。
 *
 * roofline 的横坐标。分块、融合、寄存器分块这些优化的直接证据都是它涨了。
 * 分母用「读 + 写」，和 roofline 的惯例一致。
 */
export function arithmeticIntensity(metrics: GpuMetrics): number {
  const bytes = metrics.memory.readBytes + metrics.memory.writeBytes;
  if (bytes === 0) return 0;
  // FMA 算两次浮点运算，其余算一次
  const flops = metrics.inst.fma * 2 + (metrics.inst.laneExecuted - metrics.inst.fma - metrics.inst.ldst);
  return Math.max(0, flops) / bytes;
}

/** `nvidia-smi` 的样子 */
export function formatNvidiaSmi(device: DeviceSpec, usedBytes: number): string {
  const totalMiB = Math.round(device.memoryBytes / 1024 / 1024);
  const usedMiB = Math.round(usedBytes / 1024 / 1024);
  const name = device.name.replace('NVIDIA ', '').padEnd(20).slice(0, 20);
  return [
    '+-----------------------------------------------------------------------------------------+',
    '| NVIDIA-SMI 580.65.06              Driver Version: 580.65.06      CUDA Version: 13.3     |',
    '|-----------------------------------------+------------------------+----------------------+',
    '| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |',
    '| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |',
    '|                                         |                        |               MIG M. |',
    '|=========================================+========================+======================|',
    `|   0  ${name} On  |   00000000:01:00.0 Off |                    0 |`,
    `| N/A   32C    P0             71W /  700W |${String(`${usedMiB}MiB / ${totalMiB}MiB`).padStart(23)} |      0%      Default |`,
    '|                                         |                        |             Disabled |',
    '+-----------------------------------------+------------------------+----------------------+',
    '',
    '+-----------------------------------------------------------------------------------------+',
    '| Processes:                                                                              |',
    '|  GPU   GI   CI develop        PID   Type   Process name                      GPU Memory |',
    '|        ID   ID                                                               Usage      |',
    '|=========================================================================================|',
    '|  No running processes found                                                             |',
    '+-----------------------------------------------------------------------------------------+',
  ].join('\n');
}
