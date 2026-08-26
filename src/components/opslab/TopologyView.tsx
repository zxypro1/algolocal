/**
 * 拓扑图
 *
 * 坐标是自己算的（见 lab/view.ts），这里只负责画和交互。用 @xyflow/react
 * 是为了拿到平移、缩放、fitView 这些 —— 一个集群几十个 Pod，没有这些看不了。
 *
 * 交互只有两种：看，和点一下把对应的只读命令插进终端。拖拽改状态是不做的 ——
 * 真集群里没有「把 Pod 拖到另一台机器上」这个动作，做了就是在教错的东西。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import { Group, Stack, Text } from '@mantine/core';
import type { TopologyGraph, TopologyStatus } from '../../lib/opslab/lab';

import '@xyflow/react/dist/style.css';

const STATUS_COLOR: Record<TopologyStatus, string> = {
  ok: 'var(--mantine-color-teal-6)',
  pending: 'var(--mantine-color-blue-5)',
  warn: 'var(--mantine-color-yellow-6)',
  error: 'var(--mantine-color-red-6)',
};

const EDGE_COLOR = {
  owns: 'var(--mantine-color-gray-5)',
  routes: 'var(--mantine-color-blue-4)',
  schedules: 'var(--mantine-color-gray-4)',
};

type ResourceData = {
  kind: string;
  name: string;
  detail: string;
  status: TopologyStatus;
  changed?: boolean;
  /** 包路径当前停在这一跳上 */
  onPath?: boolean;
};

/**
 * 连线要有锚点才画得出来。
 *
 * 自定义节点不放 Handle 的话，xyflow 会**静默地**一条边都不画：节点都在，
 * 关系全没了。而这张图的意义恰恰就在关系上（Service 连不连得到 Pod）。
 * 锚点本身不需要被看见，也不允许拖拽连线，所以做成透明的。
 */
const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, border: 'none', background: 'transparent' };

function ResourceNode({ data }: NodeProps) {
  const item = data as ResourceData;
  return (
    <div
      style={{
        width: 168,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${
          item.onPath ? 'var(--mantine-color-blue-6)'
            : item.changed ? 'var(--mantine-color-orange-5)'
              : 'var(--app-border)'
        }`,
        borderLeft: `4px solid ${STATUS_COLOR[item.status]}`,
        background: 'var(--mantine-color-body)',
        boxShadow: item.onPath
          ? '0 0 0 3px rgba(34,139,230,0.28)'
          : item.changed ? '0 0 0 3px rgba(255,146,43,0.18)' : 'none',
      }}
    >
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <Text size="10px" c="dimmed" tt="uppercase" lh={1.2}>{item.kind}</Text>
      <Text size="xs" fw={600} truncate lh={1.3}>{item.name}</Text>
      <Text size="10px" c="dimmed" truncate lh={1.3}>{item.detail}</Text>
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { resource: ResourceNode };

export interface TopologyViewProps {
  graph: TopologyGraph;
  /** 点节点：把只读命令插进终端 */
  onInspect?: (command: string) => void;
  /** 包路径停在哪个节点上，圈出来 */
  highlight?: string;
  /**
   * 这块面板现在是不是被选中的那一页。
   *
   * 它和终端、IDE 同属一组 tab，切走时整块是 display:none。ReactFlow 只在
   * 初始化时 fitView 一次，而它初始化的那一刻容器是 0×0 —— 不管的话切回来
   * 是一张几乎空白的画布，只有角落里露出半个节点。
   */
  active?: boolean;
}

export default function TopologyView({ graph, onInspect, highlight, active = true }: TopologyViewProps) {
  const initialNodes = useMemo<Node[]>(
    () => graph.nodes.map((node) => ({
      id: node.id,
      type: 'resource',
      position: { x: node.x, y: node.y },
      data: {
        kind: node.kind, name: node.name, detail: node.detail,
        status: node.status, changed: node.changed,
        onPath: node.id === highlight,
      },
      draggable: false,
      selectable: true,
    })),
    [graph, highlight]
  );

  const initialEdges = useMemo<Edge[]>(
    () => graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      animated: edge.kind === 'routes',
      style: { stroke: EDGE_COLOR[edge.kind], strokeWidth: edge.kind === 'routes' ? 2 : 1 },
    })),
    [graph]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 集群变了就整批替换。位置是自己算的，所以不存在「用户拖过的位置被覆盖」的问题。
  useEffect(() => { setNodes(initialNodes); }, [initialNodes, setNodes]);
  useEffect(() => { setEdges(initialEdges); }, [initialEdges, setEdges]);

  /**
   * 被选中的时候补一次 fitView。
   *
   * 早先这里挂的是 ResizeObserver，靠「宽度从 0 变正」判断自己露出来了。
   * 不可靠：ReactFlow 内部也在用 ResizeObserver 量尺寸，两个观察者的回调
   * 顺序不保证，先跑我们这个的话它内部还是 0×0，fitView 算出来没有意义。
   * 由 tab 状态驱动就确定多了 —— effect 跑在提交之后，那时布局已经定了；
   * 再推一帧，等 ReactFlow 也量完。
   */
  const containerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const onInit = useCallback((instance: ReactFlowInstance) => { flowRef.current = instance; }, []);

  useEffect(() => {
    if (!active) return undefined;
    const frame = requestAnimationFrame(() => {
      try { flowRef.current?.fitView(); } catch { /* 实例还没好，下次选中还会再来 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (graph.nodes.length === 0) {
    return (
      <Stack align="center" justify="center" h="100%" gap={4}>
        <Text size="sm" c="dimmed">这个命名空间里还没有东西</Text>
        <Text size="xs" c="dimmed">apply 一个 Deployment 试试</Text>
      </Stack>
    );
  }

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={onInit}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          const found = graph.nodes.find((item) => item.id === node.id);
          if (found) onInspect?.(found.command);
        }}
        fitView
        proOptions={{ hideAttribution: false }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ height: 72, width: 120 }} />
      </ReactFlow>
      </div>
      {/* 图例放在画布外面。浮在上面会压住第一排节点，而第一排恰好是入口层。 */}
      <Group gap={10} px="sm" py={4} style={{ borderTop: '1px solid var(--app-border)', flexShrink: 0 }}>
        {graph.lanes.map((lane, index) => (
          <Text key={lane.id} size="10px" c="dimmed">
            {index + 1}. {lane.title}
          </Text>
        ))}
        <Text size="10px" c="dimmed" ml="auto">点节点插入只读命令</Text>
      </Group>
    </div>
  );
}
