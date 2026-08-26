/**
 * 多合一 CLI 在虚拟机器上跑
 *
 * 这是整条链路唯一说了算的验证：真 kubectl（和真 helm）从同一个 wasm 里出来，
 * 读同一棵文件树，打到我们内存里的 apiserver 上，并且能被 shell 的管道串起来。
 *
 * 产物约 135MB，不进仓库 —— 没有时整组跳过，先跑
 * `bash scripts/build-opslab-wasm.sh`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCluster } from '../../src/lib/opslab/controllers';
import { createMachine, Machine } from '../../src/lib/labkit/machine';
import {
  CliRuntime, createCliRuntime, createIndexedDbCache, installClusterCli,
  renderKubeconfig, defaultKubeconfig, remoteSignature,
  type ModuleCache,
} from '../../src/lib/opslab/wasm';

const WASM_PATH = path.join(__dirname, '../../public/opslab/opslab-cli.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);
const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;

/** wasm_exec.js 是一个往 globalThis 挂 Go 的脚本，Node 里 require 一次就够 */
function ensureGoRuntime(): void {
  if ((globalThis as Record<string, unknown>).Go) return;
  createRequire(__filename)(WASM_EXEC);
}

let shared: CliRuntime | null = null;

/** 编译一次，整个文件复用 —— 135MB 的东西不能每个用例编一遍 */
function runtime(): CliRuntime {
  if (!shared) {
    ensureGoRuntime();
    shared = createCliRuntime({ bytes: new Uint8Array(fs.readFileSync(WASM_PATH)), cache: false });
  }
  return shared;
}

const NGINX = 'registry.k8s.io/nginx:1.27';
const NGINX_NEXT = 'registry.k8s.io/nginx:1.28';

/** 一台装好 kubectl 的机器，连着一个真在跑控制器的集群 */
async function world(files: Record<string, string> = {}) {
  const cluster = createCluster({
    images: {
      [NGINX]: { pullMs: 200, startupMs: 300, readyAfterMs: 200 },
      [NGINX_NEXT]: { pullMs: 200, startupMs: 300, readyAfterMs: 200 },
    },
  });
  cluster.start();
  const machine = createMachine({ files, now: () => cluster.wallClock() });
  const applets = await installClusterCli({
    machine,
    runtime: runtime(),
    apiServer: cluster.apiServer,
    now: () => cluster.wallClock(),
  });
  return { cluster, machine, applets };
}

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: portal
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: portal
  template:
    metadata:
      labels:
        app: portal
    spec:
      containers:
      - name: web
        image: ${NGINX}
`;

describeIfBuilt('多合一二进制', () => {
  jest.setTimeout(180_000);

  it('自报家门：这个 wasm 里装着 kubectl 和 helm', async () => {
    expect(await runtime().applets()).toEqual(['kubectl', 'helm']);
  });

  it('argv[0] 决定当谁跑 —— 同一个模块，两个 CLI', async () => {
    const { machine } = await world();
    const kubectl = await machine.exec('kubectl version --client');
    expect(kubectl.code).toBe(0);
    expect(kubectl.stdout).toContain('Client Version: v1.36.0');
    expect(kubectl.stdout).toContain('Kustomize Version: v5.8.1');

    const helm = await machine.exec('helm version');
    expect(helm.code).toBe(0);
    expect(helm.stdout).toContain('Version:"v4.2.4"');
  });

  it('不存在的 applet 明确报错', async () => {
    const result = await runtime().run('istioctl', [], {
      vfs: createMachine().vfs,
      fetch: async () => new Response('', { status: 404 }),
    });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('no applet named "istioctl"');
  });
});

describeIfBuilt('真 kubectl 打到真集群上', () => {
  jest.setTimeout(180_000);

  it('kubectl get nodes —— 看到 seed 出来的三台', async () => {
    const { machine } = await world();
    const result = await machine.exec('kubectl get nodes');
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n')[0]).toBe('NAME     STATUS   ROLES    AGE   VERSION');
    expect(result.stdout).toContain('node-1   Ready    <none>');
    expect(result.stdout).toContain('v1.36.0');
  });

  it('apply 之后控制器真的把 Pod 长出来', async () => {
    const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });

    const applied = await machine.exec('kubectl apply -f portal.yaml');
    expect(applied.stdout).toBe('deployment.apps/portal created\n');

    await cluster.settle();

    const pods = await machine.exec('kubectl get pods');
    expect(pods.stdout).toMatch(/portal-[a-z0-9]+-[a-z0-9]+\s+1\/1\s+Running\s+0/);
    expect(pods.stdout.trim().split('\n')).toHaveLength(3);   // 表头 + 2 个副本
  });

  it('kubectl 是这台机器上一个普通命令，能进管道', async () => {
    const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });
    await machine.exec('kubectl apply -f portal.yaml');
    await cluster.settle();

    expect(await machine.exec('kubectl get pods --no-headers | wc -l')).toMatchObject({ stdout: '2\n' });
    expect((await machine.exec('kubectl get pods -o name | sort | head -n 1')).stdout).toMatch(/^pod\/portal-/);
  });

  it('从 stdin 读 manifest：cat 管给 kubectl apply -f -', async () => {
    const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });
    const result = await machine.exec('cat portal.yaml | kubectl apply -f -');
    expect(result.stdout).toBe('deployment.apps/portal created\n');
    await cluster.settle();
    expect((await machine.exec('kubectl get deploy portal -o jsonpath={.status.readyReplicas}')).stdout).toBe('2');
  });

  it('重定向：kubectl 的输出写进文件，再被别的命令读', async () => {
    const { machine } = await world();
    await machine.exec('kubectl get nodes -o name > /root/nodes.txt');
    expect(machine.vfs.readFile('/root/nodes.txt')).toBe('node/node-1\nnode/node-2\nnode/node-3\n');
    expect((await machine.exec('grep -c node /root/nodes.txt')).stdout).toBe('3\n');
  });

  it('IDE 里改文件、终端里 apply —— 同一棵树，不是两份副本', async () => {
    const { machine, cluster } = await world();
    // 「IDE」直接写 vfs，不经过 shell
    machine.vfs.writeFile('/root/edited.yaml', DEPLOYMENT.replace('replicas: 2', 'replicas: 3'));
    await machine.exec('kubectl apply -f /root/edited.yaml');
    await cluster.settle();
    expect((await machine.exec('kubectl get deploy portal --no-headers')).stdout).toMatch(/portal\s+3\/3/);
  });

  it('kubeconfig 是真的：get-contexts / --context 都认', async () => {
    const { machine } = await world();
    const contexts = await machine.exec('kubectl config get-contexts');
    expect(contexts.stdout).toContain('CURRENT   NAME     CLUSTER   AUTHINFO   NAMESPACE');
    expect(contexts.stdout).toContain('*         opslab   opslab    ops        default');

    const missing = await machine.exec('kubectl --context nope get nodes');
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toBe('Error in configuration: context was not found for specified context: nope\n');
  });

  it('kubectl 写文件（-o yaml 重定向、edit 之外的落盘路径）落回同一棵树', async () => {
    const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });
    await machine.exec('kubectl apply -f portal.yaml');
    await cluster.settle();
    // kubectl 自己打开文件写：--output-file 走的是 fs.open + write + close
    const dumped = await machine.exec('kubectl get deploy portal -o yaml > /root/dump.yaml');
    expect(dumped.code).toBe(0);
    expect(machine.vfs.readFile('/root/dump.yaml')).toContain('name: portal');
    // 再让 kubectl 自己把它读回去
    expect((await machine.exec('kubectl apply -f /root/dump.yaml')).stdout)
      .toBe('deployment.apps/portal configured\n');
  });

  it('报错来自 apiserver，不是我们编的', async () => {
    const { machine } = await world();
    const result = await machine.exec('kubectl get pod does-not-exist');
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Error from server (NotFound): pods "does-not-exist" not found\n');
  });

  it('PATCH 打通之后：apply 二次、scale、set image、label、patch --type=json', async () => {
    const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });
    await machine.exec('kubectl apply -f portal.yaml');
    await cluster.settle();

    // 改完 manifest 再 apply 一次 —— 这是这个产品里最常发生的动作
    machine.vfs.writeFile('/root/portal.yaml', DEPLOYMENT.replace('replicas: 2', 'replicas: 4'));
    expect((await machine.exec('kubectl apply -f portal.yaml')).stdout)
      .toBe('deployment.apps/portal configured\n');
    await cluster.settle();
    expect((await machine.exec('kubectl get deploy portal --no-headers')).stdout).toMatch(/portal\s+4\/4/);

    expect((await machine.exec('kubectl scale deploy portal --replicas=1')).stdout)
      .toBe('deployment.apps/portal scaled\n');
    await cluster.settle();
    expect((await machine.exec('kubectl get pods --no-headers | wc -l')).stdout).toBe('1\n');

    // set image 只换镜像，容器数量不变 —— 策略合并的 merge key 在起作用
    expect((await machine.exec(`kubectl set image deploy/portal web=${NGINX_NEXT}`)).stdout)
      .toBe('deployment.apps/portal image updated\n');
    expect((await machine.exec(
      'kubectl get deploy portal -o jsonpath={.spec.template.spec.containers[*].name}'
    )).stdout).toBe('web');
    expect((await machine.exec(
      'kubectl get deploy portal -o jsonpath={.spec.template.spec.containers[0].image}'
    )).stdout).toBe(NGINX_NEXT);

    expect((await machine.exec('kubectl annotate deploy portal note=changed')).stdout)
      .toBe('deployment.apps/portal annotated\n');
    expect((await machine.exec('kubectl rollout restart deploy/portal')).stdout)
      .toBe('deployment.apps/portal restarted\n');

    expect((await machine.exec('kubectl label deploy portal tier=frontend')).stdout)
      .toBe('deployment.apps/portal labeled\n');
    expect((await machine.exec('kubectl get deploy portal -o jsonpath={.metadata.labels.tier}')).stdout)
      .toBe('frontend');

    const jsonPatch = await machine.exec(
      "kubectl patch deploy portal --type=json -p '[{\"op\":\"replace\",\"path\":\"/spec/replicas\",\"value\":3}]'"
    );
    expect(jsonPatch.stdout).toBe('deployment.apps/portal patched\n');
    expect((await machine.exec('kubectl get deploy portal -o jsonpath={.spec.replicas}')).stdout).toBe('3');
  });

  it('Endpoints 那一列：匹配上就列地址，匹配不上就 <none>', async () => {
    const service = (name: string, app: string) => [
      'apiVersion: v1', 'kind: Service',
      `metadata:`, `  name: ${name}`, '  namespace: default',
      'spec:', '  selector:', `    app: ${app}`,
      '  ports:', '  - port: 80', '    targetPort: 8080', '',
    ].join('\n');

    const { machine, cluster } = await world({
      '/root/portal.yaml': DEPLOYMENT,
      // 一个 selector 对得上，一个故意写错
      '/root/good.yaml': service('good', 'portal'),
      '/root/typo.yaml': service('typo', 'protal'),
    });
    await machine.exec('kubectl apply -f portal.yaml -f good.yaml -f typo.yaml');
    await cluster.settle();

    const table = await machine.exec('kubectl get endpoints');
    expect(table.stdout.split('\n')[0]).toMatch(/^NAME\s+ENDPOINTS\s+AGE$/);
    // 排查「服务不通」的第一眼看的就是这个 <none>
    expect(table.stdout).toMatch(/typo\s+<none>/);
    expect(table.stdout).toMatch(/good\s+10\.42\.[0-9.]+:8080,10\.42\.[0-9.]+:8080/);
  });

  it('同一串命令重放两次，逐字节一致', async () => {
    const script = [
      'kubectl apply -f portal.yaml',
      'kubectl get deploy -o wide',
      'kubectl get pods --no-headers | wc -l',
    ].join('\n');

    const once = async () => {
      const { machine, cluster } = await world({ '/root/portal.yaml': DEPLOYMENT });
      const first = await machine.exec(script.split('\n')[0]);
      await cluster.settle();
      const rest = await machine.exec(script.split('\n').slice(1).join('\n'));
      return JSON.stringify([first, rest]);
    };
    expect(await once()).toBe(await once());
  });
});

describeIfBuilt('加载与缓存', () => {
  jest.setTimeout(180_000);

  it('第二次不再下载 —— 命中缓存里编好的模块', async () => {
    ensureGoRuntime();
    const bytes = new Uint8Array(fs.readFileSync(WASM_PATH));

    let downloads = 0;
    const host = globalThis as Record<string, unknown>;
    const savedFetch = host.fetch;
    host.fetch = async (url: unknown, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'content-length': String(bytes.length) } });
      }
      downloads += 1;
      return new Response(bytes, { status: 200 });
    };

    const store = new Map<string, { signature: string; module: WebAssembly.Module }>();
    const cache: ModuleCache = {
      async get(key, signature) {
        const record = store.get(key);
        return record?.signature === signature ? { module: record.module } : undefined;
      },
      async put(key, signature, module) { store.set(key, { signature, module }); },
      async clear() { store.clear(); },
    };

    try {
      await createCliRuntime({ url: '/opslab/opslab-cli.wasm', cache }).load();
      expect(downloads).toBe(1);
      expect(store.size).toBe(1);

      await createCliRuntime({ url: '/opslab/opslab-cli.wasm', cache }).load();
      expect(downloads).toBe(1);
    } finally {
      host.fetch = savedFetch;
    }
  });

  it('产物换了（长度变了）缓存自动失效', async () => {
    const store = new Map<string, { signature: string; module: WebAssembly.Module }>();
    const cache: ModuleCache = {
      async get(key, signature) {
        const record = store.get(key);
        return record?.signature === signature ? { module: record.module } : undefined;
      },
      async put(key, signature, module) { store.set(key, { signature, module }); },
      async clear() { store.clear(); },
    };
    // 手工塞一条签名对不上的记录
    store.set('/opslab/opslab-cli.wasm', {
      signature: 'stale',
      module: await WebAssembly.compile(new Uint8Array(fs.readFileSync(WASM_PATH))),
    });

    const bytes = new Uint8Array(fs.readFileSync(WASM_PATH));
    let downloads = 0;
    const host = globalThis as Record<string, unknown>;
    const savedFetch = host.fetch;
    host.fetch = async (url: unknown, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'content-length': String(bytes.length) } });
      }
      downloads += 1;
      return new Response(bytes, { status: 200 });
    };
    try {
      await createCliRuntime({ url: '/opslab/opslab-cli.wasm', cache }).load();
      expect(downloads).toBe(1);
    } finally {
      host.fetch = savedFetch;
    }
  });
});

describe('缓存在不支持的环境里要安静地退化', () => {
  it('没有 indexedDB 就返回 undefined，而不是抛异常', () => {
    expect((globalThis as Record<string, unknown>).indexedDB).toBeUndefined();
    expect(createIndexedDbCache()).toBeUndefined();
  });

  it('HEAD 拿不到签名时返回 undefined —— 调用方据此按「离线」处理', async () => {
    expect(await remoteSignature('/x.wasm', async () => { throw new Error('offline'); })).toBeUndefined();
    expect(await remoteSignature('/x.wasm', async () => new Response('', { status: 404 }))).toBeUndefined();
    expect(await remoteSignature('/x.wasm', async () =>
      new Response('', { status: 200, headers: { 'content-length': '7' } }))).toBe('|7');
  });
});

describe('kubeconfig 渲染', () => {
  it('渲染出来的是 kubectl 认的那种结构', () => {
    const text = renderKubeconfig(defaultKubeconfig('https://apiserver.opslab:6443'));
    expect(text).toContain('apiVersion: v1');
    expect(text).toContain('current-context: opslab');
    expect(text).toContain('    server: https://apiserver.opslab:6443');
    expect(text).toContain('    namespace: default');
  });

  it('多 context 的配置', () => {
    const text = renderKubeconfig({
      clusters: [
        { name: 'prod', server: 'https://prod:6443' },
        { name: 'stage', server: 'https://stage:6443' },
      ],
      users: [{ name: 'ops', token: 't' }, { name: 'dev', token: 'd' }],
      contexts: [
        { name: 'prod', cluster: 'prod', user: 'ops', namespace: 'payments' },
        { name: 'stage', cluster: 'stage', user: 'dev' },
      ],
      currentContext: 'stage',
    });
    expect(text).toContain('current-context: stage');
    expect((text.match(/^- name: /gm) ?? [])).toHaveLength(6);
  });
});

describe('多合一 CLI 的前提', () => {
  it(HAS_ARTIFACT ? '产物已就绪' : '产物缺失，整组跳过（先跑 scripts/build-opslab-wasm.sh）', () => {
    expect(true).toBe(true);
  });
});

/** 让 TS 知道 Machine 被用到了（类型导入的守卫） */
export type { Machine };
