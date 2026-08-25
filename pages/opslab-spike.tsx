/**
 * opslab spike 演示页
 *
 * 证明一条链路能通：xterm 终端 → 真 kubectl（js/wasm）→ 拦截的 fetch →
 * 内存里的 mini apiserver。敲进去的是真命令，打出来的是真 kubectl 的输出。
 *
 * 这一页是 spike 产物，不进导航；第三段实现真正的工作台时会被替换掉。
 * kubectl.wasm 约 115MB，不进仓库 —— 先跑 `bash scripts/build-opslab-wasm.sh`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppShell, Badge, Code, Group, Stack, Text } from '@mantine/core';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { createStore } from '../src/lib/opslab/store';
import { createApiServer, createScheme, Registry } from '../src/lib/opslab/apiserver';
import { runKubectl } from '../src/lib/opslab/kubectlWasm';

const OpsTerminal = dynamic(() => import('../src/components/opslab/OpsTerminal'), { ssr: false });

/** 世界时间固定，输出才可复现 —— 正式版里这里接确定性内核的虚拟时钟 */
const VIRTUAL_NOW = Date.parse('2026-01-01T04:12:00Z');
const CREATED_AT = Date.parse('2026-01-01T00:00:00Z');

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
        image: registry.corp.internal/ledger:0.9
`;

/**
 * 起一个小世界：真 registry + 真 HTTP 层，不再是 spike 时手搓的那个 miniApiServer。
 * 时间固定住，输出才可复现；正式版里这里接确定性内核的虚拟时钟。
 */
function seedWorld() {
  const store = createStore();
  const scheme = createScheme([
    { group: '', version: 'v1', resource: 'namespaces', singular: 'namespace', kind: 'Namespace', namespaced: false, shortNames: ['ns'] },
    { group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod', namespaced: true, shortNames: ['po'], subresources: ['status'] },
    { group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment', kind: 'Deployment', namespaced: true, shortNames: ['deploy'], subresources: ['status', 'scale'] },
  ]);
  let uid = 0;
  const registry = new Registry({
    store,
    scheme,
    now: () => CREATED_AT,
    uid: () => `uid-${++uid}`,
  });

  const ns = scheme.mustGet({ group: '', version: 'v1', resource: 'namespaces' });
  const pods = scheme.mustGet({ group: '', version: 'v1', resource: 'pods' });
  for (const name of ['default', 'prod']) {
    registry.create(ns, undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name }, status: { phase: 'Active' } });
  }
  registry.create(pods, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'payments-7f4-2xk', labels: { app: 'payments' } },
    spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'registry.corp.internal/payments:1.4' }] },
    status: { phase: 'Running', podIP: '10.42.1.7', containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] },
  });
  registry.create(pods, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'portal-6c9-abc', labels: { app: 'portal' } },
    spec: { nodeName: 'node-2', containers: [{ name: 'app', image: 'registry.corp.internal/portal:2.1' }] },
    status: { phase: 'Running', podIP: '10.42.2.3', containerStatuses: [{ name: 'app', ready: true, restartCount: 2 }] },
  });

  return createApiServer({ registry, scheme, now: () => VIRTUAL_NOW });
}

const BANNER = [
  'opslab spike — 真 kubectl 跑在 WebAssembly 里，打到内存里的 apiserver',
  '',
  '试试：kubectl get pods -o wide / kubectl api-resources',
  '     kubectl apply -f /root/infra/ledger.yaml --validate=false',
  '     kubectl get deploy ledger -o yaml',
  '',
  '第一条命令要下载并编译 kubectl.wasm，会慢几秒；之后每条约几十毫秒。',
  '',
].join('\r\n');

export default function OpsLabSpikePage() {
  const serverRef = useRef(seedWorld());
  const [stats, setStats] = useState<{ count: number; lastMs: number } | null>(null);

  const files = useMemo(() => ({ '/root/infra/ledger.yaml': LEDGER_YAML }), []);

  const handleCommand = useCallback(async (line: string): Promise<string> => {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts[0] !== 'kubectl') {
      return `${parts[0]}: command not found\r\n(这一期只接了 kubectl；shell 与其余命令在第三段实现)\r\n`;
    }
    const started = performance.now();
    const result = await runKubectl(parts.slice(1), { server: serverRef.current, files });
    const elapsed = performance.now() - started;
    setStats((prev) => ({ count: (prev?.count ?? 0) + 1, lastMs: Math.round(elapsed) }));
    return (result.stdout + result.stderr).replace(/\n/g, '\r\n');
  }, [files]);

  // spike 页专用的自测入口：终端的渲染依赖 requestAnimationFrame，
  // 自动化浏览器里窗口不可见时不触发，于是画面是空的但功能是好的。
  // 暴露一个直接调用命令的钩子，好让 e2e 验的是链路而不是像素。
  useEffect(() => {
    (window as any).__opslabRun = handleCommand;
    return () => { delete (window as any).__opslabRun; };
  }, [handleCommand]);

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding="0">
      <AppHeader
        backHref="/projects"
        title="opslab spike"
        actions={
          <Group gap="xs">
            <Badge variant="light" color="gray">kubectl v1.36 · js/wasm</Badge>
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
              终端里跑的是<strong>真的 kubectl</strong>（编译成 WebAssembly），它通过被拦截的 fetch
              访问内存里的 apiserver —— etcd 语义存储 + REST 语义层 + 服务端表格渲染，
              三个 GVK：Namespace / Pod / Deployment。
            </Text>
            <Text size="xs" c="dimmed">
              产物不在仓库里：先运行 <Code>bash scripts/build-opslab-wasm.sh</Code> 生成{' '}
              <Code>public/opslab/kubectl.wasm</Code>。
            </Text>
          </Stack>
          <div style={{ flex: 1, minHeight: 0 }}>
            <OpsTerminal prompt="ops@ops-ws:~/infra$ " onCommand={handleCommand} banner={BANNER} />
          </div>
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
