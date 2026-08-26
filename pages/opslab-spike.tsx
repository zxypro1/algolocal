/**
 * opslab 联调页
 *
 * 一条完整的链路：xterm 终端 → 虚拟机器的 shell → 真 kubectl（js/wasm）
 * → 被拦截的 fetch → 内存里的 apiserver → 控制器把 Pod 真的调度起来。
 *
 * 敲进去的是真命令，管道、重定向都能用，kubectl 只是这台机器上的一个命令。
 * 这一页不进导航，第 3-6 片做出真正的四块面板之后会被替换掉。
 * 产物约 135MB，不进仓库 —— 先跑 `bash scripts/build-opslab-wasm.sh`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppShell, Badge, Code, Group, Stack, Text } from '@mantine/core';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { createCluster } from '../src/lib/opslab/controllers';
import { createMachine, Machine } from '../src/lib/labkit/machine';
import { installClusterCli, sharedCliRuntime } from '../src/lib/opslab/wasm';

const WorkbenchTerminal = dynamic(
  () => import('../src/components/workbench/WorkbenchTerminal'), { ssr: false }
);

const IMAGE = 'registry.corp.internal/ledger:0.9';

const LEDGER_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ledger
  namespace: default
  labels:
    app: ledger
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ledger
  template:
    metadata:
      labels:
        app: ledger
    spec:
      containers:
      - name: app
        image: ${IMAGE}
`;

const BANNER = [
  '\x1b[1mopslab\x1b[0m —— 内网基础设施实验室（联调页）',
  '',
  '  这是一台虚拟跳板机，连着一个内存里的 Kubernetes 集群。',
  '  终端里的 shell、coreutils、kubectl、helm 都是真的。',
  '',
  '  试试：',
  '     kubectl get nodes',
  '     cat infra/ledger.yaml | kubectl apply -f -',
  '     kubectl get pods -o wide',
  '     kubectl get pods --no-headers | wc -l',
  '     helm version',
  '',
  '  第一条命令要下载并编译 135MB 的 wasm，会慢几秒；之后每条约几十毫秒。',
  '',
].join('\r\n');

/** 起一个小世界：三台节点、一个能拉到的镜像、控制器全部就位 */
function createWorld() {
  const cluster = createCluster({ images: { [IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 400 } } });
  cluster.start();
  const machine = createMachine({
    hostname: 'ops-ws',
    cwd: '/root/infra',
    files: { '/root/infra/ledger.yaml': LEDGER_YAML },
    now: () => cluster.wallClock(),
  });
  return { cluster, machine };
}

export default function OpsLabSpikePage() {
  const worldRef = useRef<ReturnType<typeof createWorld> | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const [stats, setStats] = useState<{ count: number; lastMs: number } | null>(null);
  const [prompt, setPrompt] = useState('root@ops-ws:~/infra# ');

  /** CLI 要异步装（要问 wasm 里有哪些 applet），第一条命令时再等它 */
  const ready = useCallback(() => {
    if (!readyRef.current) {
      const world = createWorld();
      worldRef.current = world;
      readyRef.current = installClusterCli({
        machine: world.machine,
        runtime: sharedCliRuntime(),
        apiServer: world.cluster.apiServer,
        now: () => world.cluster.wallClock(),
      }).then(() => undefined).catch((error) => {
        // 装失败了要能再试一次，否则一次网络抖动就把整页锁死
        readyRef.current = null;
        throw error;
      });
    }
    return readyRef.current;
  }, []);

  const handleCommand = useCallback(async (line: string): Promise<string> => {
    await ready();
    const world = worldRef.current!;
    const started = performance.now();

    const result = await world.machine.exec(line);
    // 命令跑完之后让世界自己往前走一段 —— 控制器该建的 Pod 会真的建起来
    await world.cluster.settle({ maxVirtualMs: 120_000 });

    const elapsed = performance.now() - started;
    setStats((prev) => ({ count: (prev?.count ?? 0) + 1, lastMs: Math.round(elapsed) }));
    setPrompt(world.machine.prompt());
    return (result.stdout + result.stderr).replace(/\n/g, '\r\n');
  }, [ready]);

  // 自测入口：终端渲染依赖 requestAnimationFrame，自动化浏览器里窗口不可见时
  // 不触发，画面是空的但功能是好的。暴露一个直接调命令的钩子，好让 e2e 验链路。
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__opslabRun = handleCommand;
    return () => { delete (window as unknown as Record<string, unknown>).__opslabRun; };
  }, [handleCommand]);

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding="0">
      <AppHeader
        backHref="/projects"
        title="opslab 联调"
        actions={
          <Group gap="xs">
            <Badge variant="light" color="gray">kubectl v1.36 + helm v4 · js/wasm</Badge>
            {stats && (
              <Badge variant="light" color="teal">
                {stats.count} 条命令 · 上一条 {stats.lastMs}ms
              </Badge>
            )}
          </Group>
        }
      />
      <AppShell.Main>
        <div style={{ height: `calc(100vh - ${HEADER_HEIGHT}px)`, display: 'flex', flexDirection: 'column' }}>
          <Stack gap={4} px="md" py={8} style={{ borderBottom: '1px solid var(--app-border)', flexShrink: 0 }}>
            <Text size="xs" c="dimmed">
              终端里是一台虚拟机器：<strong>真 shell</strong>（tree-sitter 解析 bash）+ coreutils +
              <strong> 真 kubectl 与 helm</strong>（同一个 wasm，按 argv[0] 分发）。
              kubectl 通过被拦截的 fetch 访问内存里的 apiserver，控制器在虚拟时钟上把 Pod 调度起来。
            </Text>
            <Text size="xs" c="dimmed">
              产物不在仓库里：先运行 <Code>bash scripts/build-opslab-wasm.sh</Code> 生成{' '}
              <Code>public/opslab/opslab-cli.wasm</Code>。
            </Text>
          </Stack>
          <div style={{ flex: 1, minHeight: 0 }}>
            <WorkbenchTerminal prompt={prompt} onCommand={handleCommand} banner={BANNER} />
          </div>
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

export type { Machine };
