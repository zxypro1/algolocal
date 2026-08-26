/**
 * 剖析面板：ncu 风格的四段 + roofline
 *
 * 分段与指标名都照着 Nsight Compute 来 —— Speed Of Light / Memory Workload /
 * Occupancy / Warp State。学员在这里看熟的名字，换到真卡上 `ncu` 里
 * 一个不差地还在。
 *
 * **有一条线不能越**：这里显示的周期数与耗时是**估算**，只用于同一关内的
 * 相对比较，绝不是判定依据（门槛读的全是结构性计量：字节、扇区、指令条数）。
 * 面板上把这件事写在脸上，免得学员拿它当秒表。
 */
import { useMemo } from 'react';
import { Alert, Badge, Group, Progress, ScrollArea, Stack, Table, Text, Tooltip } from '@mantine/core';
import type { GpuWorld } from '../../lib/gpulab/lab';

export interface ProfilePanelProps {
  world: GpuWorld | null;
  revision: number;
  onInsert?: (command: string) => void;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(3);
}

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

interface Row {
  metric: string;
  value: string;
  hint?: string;
  /** 真 ncu 里对应的指标名，鼠标停上去能看到 */
  ncu?: string;
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={700} c="dimmed">{title}</Text>
      <Table withTableBorder withColumnBorders fz="xs" verticalSpacing={2} horizontalSpacing={8}>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.metric}>
              <Table.Td style={{ width: '52%' }}>
                {row.ncu ? (
                  <Tooltip label={row.ncu} position="right" multiline w={320}>
                    <Text size="xs" style={{ borderBottom: '1px dotted var(--app-border)', display: 'inline' }}>
                      {row.metric}
                    </Text>
                  </Tooltip>
                ) : (
                  <Text size="xs">{row.metric}</Text>
                )}
                {row.hint && <Text size="10px" c="dimmed">{row.hint}</Text>}
              </Table.Td>
              <Table.Td align="right"><Text size="xs" ff="monospace">{row.value}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * roofline 图。
 *
 * 横坐标是算术强度（对数），纵坐标是达到的算力（对数）。屋顶由两段组成：
 * 带宽限制的斜坡与算力限制的平台，交点就是拐点。
 * 一个点画在斜坡下面 = 访存受限，画在平台下面 = 算力受限。
 */
function Roofline({
  intensity, achieved, ridge, peakFlops, peakBandwidth,
}: {
  intensity: number; achieved: number; ridge: number;
  peakFlops: number; peakBandwidth: number;
}) {
  const W = 320;
  const H = 180;
  const pad = { l: 44, r: 8, t: 10, b: 24 };

  // 对数坐标。强度从 1/64 到 1024，算力从峰值的 1e-6 到峰值
  const xMin = Math.log10(1 / 64);
  const xMax = Math.log10(1024);
  const yMax = Math.log10(peakFlops);
  const yMin = yMax - 6;

  const px = (x: number) => pad.l + ((Math.log10(Math.max(x, 1e-6)) - xMin) / (xMax - xMin)) * (W - pad.l - pad.r);
  const py = (y: number) => pad.t + (1 - (Math.log10(Math.max(y, 1)) - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // 屋顶：斜坡段 y = x * 带宽，平台段 y = 峰值算力
  const roof: string[] = [];
  const start = Math.pow(10, xMin);
  roof.push(`M ${px(start)} ${py(start * peakBandwidth)}`);
  roof.push(`L ${px(ridge)} ${py(peakFlops)}`);
  roof.push(`L ${px(Math.pow(10, xMax))} ${py(peakFlops)}`);

  const hasPoint = intensity > 0 && achieved > 0;

  return (
    <svg width={W} height={H} role="img" aria-label="roofline">
      {/* 网格 */}
      {[-1, 0, 1, 2, 3].map((decade) => (
        <line
          key={decade}
          x1={px(Math.pow(10, decade))} y1={pad.t}
          x2={px(Math.pow(10, decade))} y2={H - pad.b}
          stroke="var(--app-border)" strokeWidth={1} strokeDasharray="2 3"
        />
      ))}
      <path d={roof.join(' ')} fill="none" stroke="var(--mantine-color-blue-5)" strokeWidth={2} />
      {/* 拐点 */}
      <line
        x1={px(ridge)} y1={py(peakFlops)} x2={px(ridge)} y2={H - pad.b}
        stroke="var(--mantine-color-blue-3)" strokeWidth={1} strokeDasharray="3 3"
      />
      <text x={px(ridge) + 3} y={H - pad.b - 3} fontSize={9} fill="var(--mantine-color-dimmed)">
        拐点 {ridge.toFixed(0)}
      </text>
      {hasPoint && (
        <>
          <circle cx={px(intensity)} cy={py(achieved)} r={4} fill="var(--mantine-color-orange-6)" />
          <text x={px(intensity) + 7} y={py(achieved) + 3} fontSize={9} fill="var(--mantine-color-orange-6)">
            {intensity.toFixed(2)} flop/B
          </text>
        </>
      )}
      {/* 坐标轴标注 */}
      <text x={pad.l} y={H - 6} fontSize={9} fill="var(--mantine-color-dimmed)">算术强度 (flop/byte)</text>
      <text x={4} y={pad.t + 8} fontSize={9} fill="var(--mantine-color-dimmed)">FLOP/s</text>
    </svg>
  );
}

export default function ProfilePanel({ world, revision, onInsert }: ProfilePanelProps) {
  const snapshot = useMemo(() => {
    if (!world) return null;
    const metrics = world.gpu.metrics();
    // 一次 kernel 都没跑过：warpExecuted 是 0
    if (metrics.inst.warpExecuted === 0) return null;
    return {
      metrics,
      stat: world.gpu.staticMetrics(),
      timing: world.gpu.timing(),
      roof: world.gpu.roofline(),
      device: world.device,
      sanitizer: world.gpu.sanitizerReport(),
    };
    // 世界是可变对象，挂在 revision 上重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revision]);

  if (!world) return <Text size="xs" c="dimmed" p="sm">设备还没准备好</Text>;

  if (!snapshot) {
    return (
      <Stack p="sm" gap="xs">
        <Text size="xs" c="dimmed">还没跑过 kernel。</Text>
        <Text size="xs" c="dimmed">
          在终端里编译并运行一次，这里就会出现和 <Text span ff="monospace" size="xs">ncu</Text> 一样的分段指标。
        </Text>
        {onInsert && (
          <Text
            size="xs"
            c="blue"
            style={{ cursor: 'pointer' }}
            onClick={() => onInsert('ncu ./bench')}
          >
            把 ncu ./bench 填进终端
          </Text>
        )}
      </Stack>
    );
  }

  const { metrics, stat, timing, roof, device, sanitizer } = snapshot;
  const peakFlops = 128 * 2 * device.smCount * 1.755e9;
  const peakBandwidth = device.memoryBandwidth;

  const sol: Row[] = [
    {
      metric: 'DRAM 读字节', value: bytes(metrics.memory.readBytes),
      ncu: 'dram__bytes_read.sum',
    },
    {
      metric: 'DRAM 写字节', value: bytes(metrics.memory.writeBytes),
      ncu: 'dram__bytes_write.sum',
    },
    {
      metric: '算术强度', value: `${num(roof.arithmeticIntensity)} flop/B`,
      hint: 'FLOP 数 / 从 DRAM 搬的字节数，两边都是精确计数',
    },
    {
      metric: 'roofline 拐点', value: `${num(roof.ridgePoint)} flop/B`,
      hint: '算术强度过了这个数就不再受带宽限制',
    },
    {
      metric: '瓶颈', value: timing.bottleneck,
      hint: '四个计算单元与访存侧里最忙的那个',
    },
  ];

  const memory: Row[] = [
    {
      metric: '全局访存请求', value: num(metrics.global.loadRequests + metrics.global.storeRequests),
      ncu: 'l1tex__t_requests_pipe_lsu_mem_global_op_ld.sum',
    },
    {
      metric: '每请求扇区数', value: num(metrics.global.sectorsPerRequest),
      hint: '合并的时候是 4，完全不合并是 32',
      ncu: 'l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio',
    },
    {
      metric: '共享内存 bank 冲突', value: num(metrics.shared.bankConflicts),
      ncu: 'l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum',
    },
    {
      metric: 'local memory 字节', value: bytes(metrics.local.readBytes + metrics.local.writeBytes),
      hint: '不是 0 就说明有数组没能待在寄存器里',
      ncu: 'l1tex__t_bytes_pipe_lsu_mem_local_op_ld.sum',
    },
  ];

  const occupancy: Row[] = [
    {
      metric: '每线程寄存器数', value: stat ? num(stat.registersPerThread) : '-',
      hint: '按活跃区间估的，不是真的寄存器分配器',
      ncu: 'launch__registers_per_thread',
    },
    {
      metric: '静态共享内存', value: stat ? bytes(stat.sharedBytesPerBlock) : '-',
      ncu: 'launch__shared_mem_per_block_static',
    },
    {
      metric: '理论占用率',
      value: stat ? `${(stat.occupancy.theoretical * 100).toFixed(1)} %` : '-',
      ncu: 'sm__maximum_warps_per_active_cycle_pct',
    },
    {
      metric: '每 SM 驻留 warp', value: stat ? num(stat.occupancy.warpsPerSm) : '-',
    },
    {
      metric: '限制因素', value: stat?.occupancy.limiter ?? '-',
      hint: '寄存器、共享内存、还是 block 数把占用率压住了',
    },
  ];

  const warp: Row[] = [
    { metric: 'warp 级指令', value: num(metrics.inst.warpExecuted) },
    {
      metric: 'lane 级指令', value: num(metrics.inst.laneExecuted),
      ncu: 'smsp__thread_inst_executed.sum',
    },
    { metric: 'FMA', value: num(metrics.inst.fma) },
    {
      metric: 'SFU（exp / log / rsqrt）', value: num(metrics.inst.sfu),
      hint: 'SFU 的吞吐只有 FMA 的 1/8',
    },
    { metric: 'tensor core 乘加', value: num(metrics.inst.mma) },
    {
      metric: '发散分支', value: num(metrics.warp.divergentBranches),
      hint: '一个 warp 里的 lane 走了不同的路',
    },
    { metric: '屏障', value: num(metrics.launch.barriers) },
    { metric: '起的 block / warp', value: `${num(metrics.launch.blocks)} / ${num(metrics.launch.warps)}` },
  ];

  return (
    <ScrollArea h="100%" type="auto">
      <Stack gap="md" p="sm">
        {sanitizer.races.length > 0 && (
          <Alert color="red" title={`racecheck 报了 ${sanitizer.races.length} 处竞态`}>
            <Text size="xs">
              在终端里跑 <Text span ff="monospace" size="xs">compute-sanitizer --tool racecheck ./bench</Text> 看详情。
            </Text>
          </Alert>
        )}

        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Text size="xs" fw={700}>{device.name}</Text>
            <Text size="10px" c="dimmed">
              {device.smCount} SM · {bytes(device.memoryBandwidth)}/s
            </Text>
          </Stack>
          <Badge size="sm" variant="light" color={timing.bottleneck === 'dram' ? 'orange' : 'blue'}>
            瓶颈：{timing.bottleneck}
          </Badge>
        </Group>

        <Section title="GPU Speed Of Light Throughput" rows={sol} />

        <Stack gap={4}>
          <Text size="xs" fw={700} c="dimmed">Roofline</Text>
          <Roofline
            intensity={roof.arithmeticIntensity}
            achieved={roof.achieved}
            ridge={roof.ridgePoint}
            peakFlops={peakFlops}
            peakBandwidth={peakBandwidth}
          />
          <Group gap={6}>
            <Text size="10px" c="dimmed">距离屋顶</Text>
            <Progress value={roof.efficiency * 100} size="sm" style={{ flex: 1 }} />
            <Text size="10px" c="dimmed">{(roof.efficiency * 100).toFixed(1)}%</Text>
          </Group>
        </Stack>

        <Section title="Memory Workload Analysis" rows={memory} />
        <Section title="Occupancy" rows={occupancy} />
        <Section title="Warp State / Instruction Mix" rows={warp} />

        {/*
          时序模型的边界写在脸上。
          没有真卡可校准，这个数只用于同一关内的相对比较 ——
          学员拿它当秒表的话，roofline 上的每条结论都会跟着不可信。
        */}
        <Alert color="gray" variant="light" p="xs">
          <Text size="10px">
            估算耗时 <Text span ff="monospace" size="10px">{timing.nanoseconds.toFixed(0)} ns</Text>
            （{num(timing.cycles)} 周期，延迟隐藏 {(timing.latencyHiding * 100).toFixed(0)}%）。
            <br />
            <Text span fw={700}>这个数只用于同一关内的相对比较，不是判定依据。</Text>
            门槛读的全是结构性计量：字节数、扇区数、指令条数。
          </Text>
        </Alert>
      </Stack>
    </ScrollArea>
  );
}
