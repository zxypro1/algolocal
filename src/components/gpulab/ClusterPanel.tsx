/**
 * 集群面板：拓扑图 + 通信计量 + 每卡负载
 *
 * 拓扑图上一条边就是一条链路，**颜色区分 NVLink 与 InfiniBand** ——
 * 因为「scale-up 走 NVLink、scale-out 走 IB」是后半程一半关卡的题眼，
 * 而张量并行跨了机这件事在数字上是 `bytesByLink.ib` 突然不为 0，
 * 在图上是一条边从蓝色变成橙色。
 *
 * 和别的面板一样：**只读同一个世界，不发消息**。
 */
import { useMemo } from 'react';
import {
  Alert, Badge, Group, Progress, ScrollArea, Stack, Table, Text, Tooltip,
} from '@mantine/core';
import type { GpuWorld } from '../../lib/gpulab/lab';

export interface ClusterPanelProps {
  world: GpuWorld | null;
  revision: number;
}

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

/**
 * 拓扑图。
 *
 * 每台机器一圈，机内的卡围成环（ring 算法走的就是这个环），
 * 机器之间画一条 IB 边。布局是**固定的**，不做力导向 ——
 * 图每次都长一样，学员才能把"上一次和这一次差在哪"看出来。
 */
function Topology({
  devices, perNode, busyByDevice, deadSet,
}: {
  devices: number;
  perNode: number;
  busyByDevice: number[];
  deadSet: Set<number>;
}) {
  const nodes = Math.ceil(devices / perNode);
  const W = 340;
  const nodeW = Math.min(150, (W - 20) / nodes - 10);
  const R = Math.max(34, nodeW / 2 - 16);
  const H = 40 + R * 2 + 40;
  const maxBusy = Math.max(1, ...busyByDevice);

  const centers = Array.from({ length: nodes }, (_, n) => ({
    x: 20 + nodeW / 2 + n * (nodeW + 12),
    y: 40 + R,
  }));

  const place = (device: number) => {
    const node = Math.floor(device / perNode);
    const withinNode = device % perNode;
    const count = Math.min(perNode, devices - node * perNode);
    const angle = (withinNode / count) * Math.PI * 2 - Math.PI / 2;
    return {
      x: centers[node].x + Math.cos(angle) * R,
      y: centers[node].y + Math.sin(angle) * R,
    };
  };

  return (
    <svg width={W} height={H} role="img" aria-label="GPU 拓扑">
      {/* 机器的框 */}
      {centers.map((center, n) => (
        <g key={n}>
          <rect
            x={center.x - nodeW / 2} y={20}
            width={nodeW} height={R * 2 + 30} rx={8}
            fill="none" stroke="var(--app-border)" strokeDasharray="3 3"
          />
          <text x={center.x} y={16} fontSize={9} textAnchor="middle" fill="var(--mantine-color-dimmed)">
            node {n}
          </text>
        </g>
      ))}

      {/* 机内的环：NVLink */}
      {Array.from({ length: devices }, (_, d) => {
        const node = Math.floor(d / perNode);
        const count = Math.min(perNode, devices - node * perNode);
        if (count < 2) return null;
        const next = node * perNode + ((d % perNode) + 1) % count;
        const a = place(d);
        const b = place(next);
        return (
          <line
            key={`nv-${d}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="var(--mantine-color-blue-5)" strokeWidth={1.5} opacity={0.55}
          />
        );
      })}

      {/* 机器之间：IB */}
      {centers.slice(1).map((center, index) => (
        <line
          key={`ib-${index}`}
          x1={centers[index].x + nodeW / 2} y1={center.y}
          x2={center.x - nodeW / 2} y2={center.y}
          stroke="var(--mantine-color-orange-6)" strokeWidth={2}
        />
      ))}

      {/* 卡 */}
      {Array.from({ length: devices }, (_, d) => {
        const point = place(d);
        const dead = deadSet.has(d);
        const load = busyByDevice[d] ?? 0;
        return (
          <Tooltip key={d} label={`GPU ${d}：${load} 个 block${dead ? '（已掉线）' : ''}`}>
            <g>
              <circle
                cx={point.x} cy={point.y} r={11}
                fill={dead
                  ? 'var(--mantine-color-red-8)'
                  : `hsl(200, 60%, ${62 - (load / maxBusy) * 30}%)`}
                stroke={dead ? 'var(--mantine-color-red-4)' : 'var(--app-border)'}
                strokeWidth={dead ? 2 : 1}
              />
              <text
                x={point.x} y={point.y + 3.5} fontSize={9}
                textAnchor="middle" fill="white"
              >
                {d}
              </text>
            </g>
          </Tooltip>
        );
      })}
    </svg>
  );
}

export default function ClusterPanel({ world, revision }: ClusterPanelProps) {
  const snapshot = useMemo(() => {
    const cluster = world?.cluster;
    if (!cluster) return null;
    const imbalance = cluster.imbalance();
    const dead = new Set<number>();
    for (let d = 0; d < cluster.count; d += 1) if (cluster.isDead(d)) dead.add(d);
    return {
      cluster,
      comm: cluster.comm,
      pipeline: cluster.pipeline,
      imbalance,
      dead,
    };
    // 世界是可变对象，挂在 revision 上重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revision]);

  if (!snapshot) {
    return <Text size="xs" c="dimmed" p="sm">这一关只有一张卡</Text>;
  }

  const { cluster, comm, pipeline, imbalance, dead } = snapshot;
  const totalLink = comm.bytesByLink.nvlink + comm.bytesByLink.ib + comm.bytesByLink.pcie;
  const ibShare = totalLink > 0 ? comm.bytesByLink.ib / totalLink : 0;

  return (
    <ScrollArea h="100%" type="auto">
      <Stack gap="md" p="sm">
        <Group justify="space-between">
          <Text size="xs" fw={700}>
            {cluster.count} 张卡 · {Math.ceil(cluster.count / cluster.spec.devicesPerNode)} 台机器
          </Text>
          {dead.size > 0 && (
            <Badge size="sm" color="red" variant="light">{dead.size} 张已掉线</Badge>
          )}
        </Group>

        <Topology
          devices={cluster.count}
          perNode={cluster.spec.devicesPerNode}
          busyByDevice={imbalance.blocksByDevice}
          deadSet={dead}
        />
        <Group gap="xs">
          <Badge size="xs" variant="light" color="blue">NVLink（机内）</Badge>
          <Badge size="xs" variant="light" color="orange">InfiniBand（跨机）</Badge>
          <Text size="10px" c="dimmed">颜色深浅 = 这张卡起了多少 block</Text>
        </Group>

        {/*
          IB 占比是张量并行跨机的直接证据。
          这一条不是装饰：真实工程里最常见、代价也最大的配置错误就是它，
          而它在别的地方看不出来 —— 结果完全正确，只是慢。
        */}
        {ibShare > 0 && (
          <Alert color={ibShare > 0.1 ? 'orange' : 'gray'} variant="light" p="xs">
            <Text size="10px">
              有 {(ibShare * 100).toFixed(1)}% 的通信走了 InfiniBand。
              机内 NVLink 与跨机 IB 的带宽差将近一个数量级 ——
              如果这是张量并行，它就跨机了。
            </Text>
          </Alert>
        )}

        <Stack gap={4}>
          <Text size="xs" fw={700} c="dimmed">通信</Text>
          <Table withTableBorder fz="xs" verticalSpacing={2} horizontalSpacing={8}>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>总字节</Table.Td>
                <Table.Td align="right">{bytes(comm.bytes)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>消息条数</Table.Td>
                <Table.Td align="right">{comm.messages.toLocaleString('en-US')}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>
                  <Tooltip label="最忙那张卡的端口上过了多少字节。ring all-reduce 摊的就是它" position="right">
                    <Text size="xs" style={{ borderBottom: '1px dotted var(--app-border)', display: 'inline' }}>
                      最忙那张卡
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td align="right">{bytes(comm.maxDeviceBytes)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>NVLink / IB / PCIe</Table.Td>
                <Table.Td align="right">
                  {bytes(comm.bytesByLink.nvlink)} / {bytes(comm.bytesByLink.ib)} / {bytes(comm.bytesByLink.pcie)}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>
                  <Tooltip label="algbw = 缓冲区字节数 / 耗时；busbw = algbw × 集合操作的修正因子" position="right">
                    <Text size="xs" style={{ borderBottom: '1px dotted var(--app-border)', display: 'inline' }}>
                      algbw / busbw
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td align="right">
                  {(comm.algbw / 1e9).toFixed(2)} / {(comm.busbw / 1e9).toFixed(2)} GB/s
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>
                  <Tooltip
                    label="发起集合操作时别的流上还有没有计算在飞。同一个流上不算重叠"
                    position="right"
                  >
                    <Text size="xs" style={{ borderBottom: '1px dotted var(--app-border)', display: 'inline' }}>
                      与计算重叠
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td align="right">{(comm.overlapRatio * 100).toFixed(1)} %</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Stack>

        {pipeline.steps > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={700} c="dimmed">流水线</Text>
            <Table withTableBorder fz="xs" verticalSpacing={2} horizontalSpacing={8}>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>步数</Table.Td>
                  <Table.Td align="right">{pipeline.steps}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>干活的格子 / 总格子</Table.Td>
                  <Table.Td align="right">
                    {pipeline.busySlots} / {pipeline.steps * cluster.count}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>气泡率</Table.Td>
                  <Table.Td align="right">{(pipeline.bubbleRatio * 100).toFixed(2)} %</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Stack>
        )}

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" fw={700} c="dimmed">每张卡的负载</Text>
            <Badge
              size="xs"
              variant="light"
              color={imbalance.maxOverMean > 1.3 ? 'orange' : 'teal'}
            >
              不均度 {imbalance.maxOverMean.toFixed(3)}
            </Badge>
          </Group>
          {imbalance.blocksByDevice.map((blocks, device) => {
            const max = Math.max(1, ...imbalance.blocksByDevice);
            return (
              <Group key={device} gap={6} wrap="nowrap">
                <Text size="10px" c="dimmed" w={44} style={{ flexShrink: 0 }}>
                  GPU {device}
                </Text>
                <Progress
                  value={(blocks / max) * 100}
                  color={dead.has(device) ? 'red' : 'blue'}
                  size="sm"
                  style={{ flex: 1 }}
                />
                <Text size="10px" ff="monospace" w={52} ta="right" style={{ flexShrink: 0 }}>
                  {blocks}
                </Text>
              </Group>
            );
          })}
          <Text size="10px" c="dimmed">
            块数就是平台观测到的工作量 —— 专家并行那一关的不均度门槛读的是它。
          </Text>
        </Stack>
      </Stack>
    </ScrollArea>
  );
}
