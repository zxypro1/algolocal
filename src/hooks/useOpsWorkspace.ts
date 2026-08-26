/**
 * ops 工作台的会话状态
 *
 * 一个世界（集群 + 机器 + 仓库 + 真 CLI），四块面板都从它取数据。
 * 面板之间不互相发消息 —— 单一数据源、单向数据流，这是设计里定死的一条。
 *
 * 世界是个可变对象，React 看不见它内部的变化，所以每做完一件事就把
 * `revision` 加一，投影（拓扑、变更流）用 useMemo 挂在这个数上重算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KubeObject } from '../lib/opslab/apiserver';
import type { CommandRecord } from '../lib/labkit/machine';
import {
  buildPacketPaths, buildTopology, createOpsWorld, currentNamespaceOf, diffVersions, snapshotVersions,
  type ChangeEntry, type OpsWorld, type PacketPath, type TopologyGraph,
} from '../lib/opslab/lab';
import { sharedCliRuntime } from '../lib/opslab/wasm';
import type { OpsStageSpec, OpsWorldSpec } from '../lib/engineering/types';

export type OpsBootStatus = 'idle' | 'booting' | 'ready' | 'error';

export interface UseOpsWorkspaceOptions {
  world?: OpsWorldSpec;
  stage?: OpsStageSpec;
  /** 关卡编号变了就重建世界 */
  stageKey: string;
  /** IDE 里的草稿，开局覆盖到机器磁盘上 */
  files?: Record<string, string>;
}

export interface OpsWorkspaceState {
  world: OpsWorld | null;
  /**
   * 世界变过几次。
   *
   * 世界是个可变对象，React 看不见它内部的变化 —— 面板要重算什么，
   * 就把这个数放进依赖里。
   */
  revision: number;
  status: OpsBootStatus;
  error?: string;
  /** 装上的真 CLI */
  applets: string[];
  topology: TopologyGraph;
  /** 最近几次连接走过的路，最新的在前 */
  packetPaths: PacketPath[];
  /** 最近一次命令引起的变更 */
  changes: ChangeEntry[];
  events: KubeObject[];
  history: CommandRecord[];
  /** 终端调它；返回要打印的文本（已转成 \r\n） */
  runCommand(line: string): Promise<string>;
  /** 编辑器保存：写回机器磁盘 */
  writeFile(path: string, content: string): void;
  prompt: string;
  /** 从头再来 */
  reboot(): void;
  /** 重置过几次。世界被推倒重来之后，挂在旧世界上的结论（比如 AI 复盘）就该作废 */
  generation: number;
  /** 拓扑图要不要展开 ReplicaSet */
  showReplicaSets: boolean;
  setShowReplicaSets(value: boolean): void;
  namespace: string;
  setNamespace(value: string): void;
}

const EMPTY_TOPOLOGY: TopologyGraph = { lanes: [], nodes: [], edges: [], width: 0, height: 0 };

export function useOpsWorkspace(options: UseOpsWorkspaceOptions): OpsWorkspaceState {
  const { stageKey } = options;
  const [world, setWorld] = useState<OpsWorld | null>(null);
  const [status, setStatus] = useState<OpsBootStatus>('idle');
  const [error, setError] = useState<string>();
  const [applets, setApplets] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [generation, setGeneration] = useState(0);
  const [showReplicaSets, setShowReplicaSets] = useState(false);
  const [namespace, setNamespaceState] = useState('default');
  /** 学员自己在下拉框里选过之后，就不再跟着 kubeconfig 跑 */
  const namespacePinned = useRef(false);

  /** 上一张拓扑，用来标出「刚才那一下改了什么」 */
  const previousTopology = useRef<TopologyGraph | undefined>(undefined);
  const versionSnapshot = useRef<Map<string, string>>(new Map());

  // 世界只在浏览器里建：真 CLI 是 wasm，SSR 阶段没有它
  useEffect(() => {
    let cancelled = false;
    setStatus('booting');
    setError(undefined);
    setWorld(null);
    setChanges([]);
    previousTopology.current = undefined;

    (async () => {
      try {
        const next = await createOpsWorld({
          world: options.world,
          stage: {
            ...options.stage,
            files: { ...(options.stage?.files ?? {}), ...(options.files ?? {}) },
          },
          runtime: sharedCliRuntime(),
        });
        if (cancelled) return;
        versionSnapshot.current = snapshotVersions(next.cluster);
        namespacePinned.current = false;
        setNamespaceState(namespaceOf(next));
        setWorld(next);
        setApplets(next.applets);
        setStatus('ready');
        setRevision((value) => value + 1);
      } catch (bootError) {
        if (cancelled) return;
        setError(bootError instanceof Error ? bootError.message : String(bootError));
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
    // files 只在开局铺一次；之后由编辑器直接写 vfs，不该重建世界
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKey, generation]);

  const runCommand = useCallback(async (line: string): Promise<string> => {
    if (!world) return '世界还没起来，稍等一下\r\n';
    previousTopology.current = buildTopology(world.cluster, { namespace, showReplicaSets });

    const before = versionSnapshot.current;
    const result = await world.run(line);
    const after = snapshotVersions(world.cluster);
    versionSnapshot.current = after;

    setChanges(diffVersions(before, after, world.now()));
    // `kubectl config use-context` / `-n` 会换命名空间，拓扑该跟着走
    if (!namespacePinned.current) setNamespaceState(namespaceOf(world));
    setRevision((value) => value + 1);
    return (result.stdout + result.stderr).replace(/\n/g, '\r\n');
  }, [world, namespace, showReplicaSets]);

  const writeFile = useCallback((path: string, content: string) => {
    if (!world) return;
    world.machine.vfs.writeFile(path, content);
    setRevision((value) => value + 1);
  }, [world]);

  const topology = useMemo(() => {
    if (!world) return EMPTY_TOPOLOGY;
    return buildTopology(world.cluster, {
      namespace,
      showReplicaSets,
      previous: previousTopology.current,
    });
    // revision 是刷新信号，不是真的被读了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revision, namespace, showReplicaSets]);

  /**
   * 包路径依赖拓扑图：能对上节点的跳才带 nodeId。
   * 所以它排在 topology 后面算，而不是并列。
   */
  const packetPaths = useMemo(() => {
    if (!world) return [];
    return buildPacketPaths(world.cluster, topology);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revision, topology]);

  const events = useMemo(() => {
    if (!world) return [];
    const definition = world.cluster.scheme.get({ group: '', version: 'v1', resource: 'events' });
    if (!definition) return [];
    return world.cluster.registry.list(definition, { namespace }).items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revision, namespace]);

  const history = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => world?.machine.transcript() ?? [],
    [world, revision]
  );

  return {
    world,
    revision,
    status,
    error,
    applets,
    topology,
    packetPaths,
    changes,
    events,
    history,
    runCommand,
    writeFile,
    prompt: world?.machine.prompt() ?? '$ ',
    reboot: () => setGeneration((value) => value + 1),
    generation,
    showReplicaSets,
    setShowReplicaSets,
    namespace,
    setNamespace: (value: string) => { namespacePinned.current = true; setNamespaceState(value); },
  };
}

/**
 * 拓扑该看哪个命名空间。
 *
 * 跟着 kubeconfig 的 current-context 走 —— 关卡在 `payments` 里干活，
 * 拓扑却盯着 `default`，学员会以为自己什么都没建出来。
 */
function namespaceOf(world: OpsWorld): string {
  const path = `${world.machine.shell.env.HOME ?? '/root'}/.kube/config`;
  if (!world.machine.vfs.exists(path)) return 'default';
  return currentNamespaceOf(world.machine.vfs.readFile(path));
}

export default useOpsWorkspace;
