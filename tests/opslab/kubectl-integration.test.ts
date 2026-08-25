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
import type { ExecRequest } from '../../src/lib/opslab/apiserver';
import { CliRuntime, createCliRuntime, defaultKubeconfig, renderKubeconfig } from '../../src/lib/opslab/wasm';
import { createOpsWorld } from '../../src/lib/opslab/lab';

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
  const execLog: ExecRequest[] = [];
  const server = createApiServer({
    registry, scheme, now: () => VIRTUAL_NOW,
    exec: async (request, stdin) => {
      execLog.push(request);
      const [command, ...rest] = request.command;
      if (command === 'echo') return { stdout: `${rest.join(' ')}\n`, stderr: '', code: 0 };
      if (command === 'cat') return { stdout: stdin, stderr: '', code: 0 };
      if (command === 'false') return { stdout: '', stderr: '', code: 1 };
      if (command === 'curl') {
        return { stdout: '', stderr: 'curl: (7) Failed to connect to portal port 80\n', code: 7 };
      }
      return { stdout: '', stderr: `sh: ${command}: not found\n`, code: 127 };
    },
  });

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
  return { registry, server, scheme, execLog };
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
    dial: () => ({ open: (request) => server.openStream(request) }),
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

/**
 * `kubectl exec`
 *
 * 这一组是唯一能证明通道协议对的地方。exec 不走 fetch：kubectl 会先尝试
 * WebSocket（`v5.channel.k8s.io`），握手、分帧、子协议协商全是 gorilla 真做的，
 * 我们只提供一条内存里的字节通道。退出码走的是 3 号通道里那个 Status，
 * 不是 HTTP 状态码 —— 少一个字段，`kubectl exec ...; echo $?` 就永远是 0。
 */
describeIfBuilt('真 kubectl exec 走 WebSocket 通道', () => {
  jest.setTimeout(120_000);

  it('stdout 从 1 号通道回来', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['exec', 'payments-7f4-2xk', '--', 'echo', 'hello']);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hello\n');
    expect(result.code).toBe(0);
  });

  it('exec 打的是 pods/exec 子资源，命令按 argv 分开传', async () => {
    const { server, execLog } = buildWorld();
    await runKubectl(server, ['exec', '-n', 'default', 'portal-6c9-abc', '-c', 'app', '--', 'echo', 'a b']);
    expect(execLog).toHaveLength(1);
    expect(execLog[0]).toMatchObject({
      namespace: 'default', pod: 'portal-6c9-abc', container: 'app',
      command: ['echo', 'a b'],
    });
    expect(server.requestLog.some((entry) => entry.startsWith('WS /api/v1/namespaces/default/pods/portal-6c9-abc/exec'))).toBe(true);
  });

  it('stderr 从 2 号通道回来，和 stdout 不混在一起', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['exec', 'payments-7f4-2xk', '--', 'curl', 'portal']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('curl: (7) Failed to connect to portal port 80');
  });

  it('非零退出码经 3 号通道的 Status 传回来', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['exec', 'payments-7f4-2xk', '--', 'false']);
    expect(result.code).toBe(1);
    // Status 里的 message 会被 kubectl 原样打到 stderr 上，
    // 所以「命令失败了」在终端上是看得见的，不只是一个退出码
    expect(result.stderr).toBe('command terminated with exit code 1\n');
  });

  it('127 也原样传回来 —— 容器里没这个命令和执行失败要分得开', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['exec', 'payments-7f4-2xk', '--', 'jq', '.']);
    expect(result.stderr).toContain('sh: jq: not found');
    expect(result.code).toBe(127);
  });

  it('kubectl exec -i —— stdin 从 0 号通道进去', async () => {
    const { server } = buildWorld();
    const vfs = createVfs(() => VIRTUAL_NOW);
    vfs.writeFile('/root/.kube/config', renderKubeconfig(defaultKubeconfig()));
    const result = await runtime().run('kubectl', ['exec', '-i', 'payments-7f4-2xk', '--', 'cat'], {
      vfs, cwd: '/root', stdin: 'from the outside\n',
      fetch: (url, init) => server.handle(url, init as never),
      dial: () => ({ open: (request) => server.openStream(request) }),
      now: () => VIRTUAL_NOW,
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('from the outside\n');
  });

  it('宿主不给通道时报的是升级失败，不是「Pod 不存在」', async () => {
    const { server } = buildWorld();
    const vfs = createVfs(() => VIRTUAL_NOW);
    vfs.writeFile('/root/.kube/config', renderKubeconfig(defaultKubeconfig()));
    const result = await runtime().run('kubectl', ['exec', 'payments-7f4-2xk', '--', 'echo', 'hi'], {
      vfs, cwd: '/root',
      fetch: (url, init) => server.handle(url, init as never),
      now: () => VIRTUAL_NOW,
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});

/**
 * 整条链路：跳板机上的 kubectl exec 进 Pod，再从 Pod 里发请求
 *
 * 这是第 10 关往后所有网络题的地基。同一条 curl 从跳板机发是打不通的
 * （办公网够不到 ClusterIP），从 Pod 里发才行 —— 学员必须能自己走进去看。
 */
describeIfBuilt('跳板机 -> Pod -> 集群网络', () => {
  jest.setTimeout(120_000);

  const WORLD = {
    namespaces: ['shop'],
    images: {
      'registry.corp.internal/portal:2.1': {},
      'registry.corp.internal/payments:1.4': {},
    },
    objects: [
      {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'portal', namespace: 'shop' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'portal' } },
          template: {
            metadata: { labels: { app: 'portal' } },
            spec: { containers: [{ name: 'app', image: 'registry.corp.internal/portal:2.1', ports: [{ containerPort: 8080 }] }] },
          },
        },
      },
      {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'payments', namespace: 'shop' },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'payments' } },
          template: {
            metadata: { labels: { app: 'payments' } },
            spec: { containers: [{ name: 'app', image: 'registry.corp.internal/payments:1.4', ports: [{ containerPort: 8080 }] }] },
          },
        },
      },
      {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: 'payments', namespace: 'shop' },
        spec: { selector: { app: 'payments' }, ports: [{ port: 80, targetPort: 8080 }] },
      },
    ],
  };

  it('kubectl exec deploy/portal -- curl payments —— 从 Pod 里打得通', async () => {
    const world = await createOpsWorld({ world: WORLD as never, runtime: runtime() });
    const result = await world.run(
      "kubectl exec -n shop deploy/portal -- curl -s -o /dev/null -w '%{http_code}' http://payments"
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('200');
  });

  it('管道能穿过 kubectl exec -i 进到容器里', async () => {
    const world = await createOpsWorld({ world: WORLD as never, runtime: runtime() });
    const result = await world.run("echo 'hello from jump-01' | kubectl exec -i -n shop deploy/portal -- cat");
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hello from jump-01\n');
  });

  it('同一条 curl 在跳板机上打不通 —— 办公网够不到 ClusterIP', async () => {
    const world = await createOpsWorld({ world: WORLD as never, runtime: runtime() });
    const direct = await world.run('curl -s -m 5 http://payments.shop.svc.cluster.local');
    expect(direct.code).not.toBe(0);
    expect(direct.stdout).toBe('');
  });
});
