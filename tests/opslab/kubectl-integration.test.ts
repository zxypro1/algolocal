/**
 * 真 kubectl 打到我们的 apiserver 上
 *
 * 这是整条链路唯一说了算的验证：前面那些单元测试证明的是「我们以为 kubectl 想要什么」，
 * 这里证明的是「kubectl 真的接受」。跑的是 src/lib/opslab/wasm 里那套运行时 ——
 * 和工作台用的是同一份代码，不是测试里另写一遍。
 *
 * 产物约 135MB，不进仓库 —— 没有时整组跳过，
 * 先跑 `bash scripts/build-opslab-wasm.sh` 生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createStore } from '../../src/lib/opslab/store';
import {
  ApiServer,
  createApiServer,
  createScheme,
  Registry,
  ResourceDefinition,
} from '../../src/lib/opslab/apiserver';
import { createVfs } from '../../src/lib/opslab/machine';
import { CliRuntime, createCliRuntime, defaultKubeconfig, renderKubeconfig } from '../../src/lib/opslab/wasm';

const WASM_PATH = path.join(__dirname, '../../public/opslab/opslab-cli.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);

const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;

const PODS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod',
  namespaced: true, shortNames: ['po'], subresources: ['status'],
};
const NAMESPACES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'namespaces', singular: 'namespace',
  kind: 'Namespace', namespaced: false, shortNames: ['ns'],
};
const DEPLOYMENTS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment',
  kind: 'Deployment', namespaced: true, shortNames: ['deploy'], subresources: ['status', 'scale'],
};

/** 虚拟世界的「现在」固定住，AGE 列才可复现 */
const VIRTUAL_NOW = Date.parse('2026-01-01T04:12:00Z');

function buildWorld() {
  const store = createStore();
  const scheme = createScheme([PODS, NAMESPACES, DEPLOYMENTS]);
  let uid = 0;
  const registry = new Registry({
    store, scheme,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    uid: () => `uid-${++uid}`,
  });
  const server = createApiServer({ registry, scheme, now: () => VIRTUAL_NOW });

  registry.create(NAMESPACES, undefined, {
    apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' }, status: { phase: 'Active' },
  });
  registry.create(PODS, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'payments-7f4-2xk', labels: { app: 'payments' } },
    spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'registry.corp.internal/payments:1.4' }] },
    status: { phase: 'Running', podIP: '10.42.1.7', containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] },
  });
  registry.create(PODS, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'portal-6c9-abc', labels: { app: 'portal' } },
    spec: { nodeName: 'node-2', containers: [{ name: 'app', image: 'registry.corp.internal/portal:2.1' }] },
    status: { phase: 'Running', podIP: '10.42.2.3', containerStatuses: [{ name: 'app', ready: true, restartCount: 2 }] },
  });
  return { registry, server, scheme };
}

let shared: CliRuntime | null = null;

/** 编译一次，整个文件复用 —— 135MB 的东西不能每个用例编一遍 */
function runtime(): CliRuntime {
  if (!shared) {
    if (!(globalThis as Record<string, unknown>).Go) createRequire(__filename)(WASM_EXEC);
    shared = createCliRuntime({ bytes: new Uint8Array(fs.readFileSync(WASM_PATH)), cache: false });
  }
  return shared;
}

async function runKubectl(
  server: ApiServer,
  args: string[],
  files: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const vfs = createVfs(() => VIRTUAL_NOW);
  vfs.writeFile('/root/.kube/config', renderKubeconfig(defaultKubeconfig()));
  vfs.populate(files);
  return runtime().run('kubectl', args, {
    vfs,
    cwd: '/root',
    fetch: (url, init) => server.handle(url, init as never),
    now: () => VIRTUAL_NOW,
  });
}

describeIfBuilt('真 kubectl 打到我们的 apiserver', () => {
  jest.setTimeout(120_000);

  it('kubectl get pods —— 服务端渲染的表格', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pods']);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'NAME               READY   STATUS    RESTARTS   AGE\n' +
      'payments-7f4-2xk   1/1     Running   0          4h12m\n' +
      'portal-6c9-abc     1/1     Running   2          4h12m\n'
    );
  });

  it('kubectl get pods -o wide —— priority 1 的列出现', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pods', '-o', 'wide']);
    expect(result.stdout).toContain('IP          NODE     NOMINATED NODE   READINESS GATES');
    expect(result.stdout).toContain('10.42.1.7   node-1   <none>           <none>');
  });

  it('简称经 discovery 解析：po == pods', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'po', '-o', 'name']);
    expect(result.stdout).toBe('pod/payments-7f4-2xk\npod/portal-6c9-abc\n');
  });

  it('kubectl api-resources 列出 discovery 的内容', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['api-resources']);
    expect(result.stdout).toContain('NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND');
    expect(result.stdout).toContain('pods          po           v1           true         Pod');
    expect(result.stdout).toContain('deployments   deploy       apps/v1      true         Deployment');
  });

  it('找不到的报错是 apiserver 发的那一句', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pod', 'nope']);
    expect(result.stderr.trim()).toBe('Error from server (NotFound): pods "nope" not found');
    expect(result.code).not.toBe(0);
  });

  it('kubectl apply 建出对象，并写上 last-applied-configuration', async () => {
    const { server, registry, scheme } = buildWorld();
    const manifest = [
      'apiVersion: apps/v1', 'kind: Deployment',
      'metadata:', '  name: ledger', '  namespace: default',
      'spec:', '  replicas: 3',
      '  selector:', '    matchLabels:', '      app: ledger',
      '  template:', '    metadata:', '      labels:', '        app: ledger',
      '    spec:', '      containers:', '      - name: app',
      '        image: registry.corp.internal/ledger:0.9', '',
    ].join('\n');

    const result = await runKubectl(
      server,
      ['apply', '-f', '/root/infra/ledger.yaml', '--validate=false'],
      { '/root/infra/ledger.yaml': manifest }
    );
    expect(result.stdout.trim()).toBe('deployment.apps/ledger created');

    const stored = registry.get(scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }), 'default', 'ledger');
    expect(stored.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeDefined();
    expect((stored.spec as any).replicas).toBe(3);
  });

  it('-o jsonpath 与 custom-columns 都是 kubectl 自己算的', async () => {
    const { server } = buildWorld();
    const jsonpath = await runKubectl(server, [
      'get', 'pod', 'payments-7f4-2xk', '-o', 'jsonpath={.spec.containers[0].image}',
    ]);
    expect(jsonpath.stdout).toBe('registry.corp.internal/payments:1.4');

    const columns = await runKubectl(server, [
      'get', 'pods', '--sort-by', '.metadata.name',
      '-o', 'custom-columns=NAME:.metadata.name,NODE:.spec.nodeName',
    ]);
    expect(columns.stdout).toBe(
      'NAME               NODE\n' +
      'payments-7f4-2xk   node-1\n' +
      'portal-6c9-abc     node-2\n'
    );
  });

  it('同一串命令重放 5 次，输出逐字节一致', async () => {
    const transcript = async () => {
      const { server } = buildWorld();
      const out: string[] = [];
      for (const args of [['get', 'pods'], ['get', 'ns'], ['api-resources'], ['get', 'pod', 'nope']]) {
        const result = await runKubectl(server, args);
        out.push(`$ kubectl ${args.join(' ')}\n${result.stdout}${result.stderr}[exit ${result.code}]`);
      }
      return out.join('\n');
    };
    const first = await transcript();
    for (let i = 0; i < 4; i += 1) expect(await transcript()).toBe(first);
  });
});

describe('kubectl 集成测试的前提', () => {
  it(HAS_ARTIFACT ? '产物已就绪' : '产物缺失，整组跳过（先跑 scripts/build-opslab-wasm.sh）', () => {
    // 这一条永远通过，只是把跳过的原因写进测试报告，免得「没跑」被误读成「跑过了」
    expect(true).toBe(true);
  });
});
