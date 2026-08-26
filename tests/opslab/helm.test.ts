/**
 * 真 helm 打到我们的 apiserver 上
 *
 * helm 4 用的是**服务端 apply**：整份对象 PATCH 过去，服务端合并并记下
 * 归属。所以这一组同时在验两件事 —— helm 能不能干活，以及我们的 SSA
 * 对不对。
 *
 * 产物约 136MB，不进仓库 —— 没有时整组跳过，
 * 先跑 `bash scripts/build-opslab-wasm.sh`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createVfs } from '../../src/lib/labkit/machine';
import { CliRuntime, createCliRuntime, defaultKubeconfig, renderKubeconfig } from '../../src/lib/opslab/wasm';
import { Cluster, createCluster } from '../../src/lib/opslab/controllers';

const WASM_PATH = path.join(__dirname, '../../public/opslab/opslab-cli.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);
const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;

const NOW = Date.parse('2026-03-02T09:00:00Z');

let shared: CliRuntime | null = null;
function cli(): CliRuntime {
  if (!shared) {
    if (!(globalThis as Record<string, unknown>).Go) createRequire(__filename)(WASM_EXEC);
    shared = createCliRuntime({ bytes: new Uint8Array(fs.readFileSync(WASM_PATH)), cache: false });
  }
  return shared;
}

function bench() {
  const cluster = createCluster();
  cluster.start();
  const vfs = createVfs(() => NOW);
  vfs.mkdirp('/root');
  vfs.writeFile('/root/.kube/config', renderKubeconfig(defaultKubeconfig()));
  const helm = (argv: string[]) => cli().run('helm', argv, {
    vfs, cwd: '/root',
    env: { KUBECONFIG: '/root/.kube/config', HELM_NAMESPACE: 'default' },
    fetch: (url, init) => cluster.apiServer.handle(url, init as never),
    now: () => NOW,
  });
  return { cluster, vfs, helm };
}

const deploymentsOf = (cluster: Cluster) =>
  cluster.registry.list(cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }), {});

describeIfBuilt('真 helm', () => {
  jest.setTimeout(180_000);

  it('helm create 铺出一个完整的 chart', async () => {
    const { vfs, helm } = bench();
    const result = await helm(['create', 'portal']);
    expect(result.code).toBe(0);
    const files = vfs.walkAll('/root/portal').map((entry) => entry.slice('/root/portal/'.length));
    expect(files).toContain('Chart.yaml');
    expect(files).toContain('values.yaml');
    expect(files).toContain('templates/deployment.yaml');
    expect(files).toContain('templates/_helpers.tpl');
  });

  it('helm template 渲染出来的是真 YAML，--set 改得动', async () => {
    const { helm } = bench();
    await helm(['create', 'portal']);
    const rendered = await helm(['template', 'portal', './portal', '--set', 'replicaCount=4']);
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).toContain('kind: Deployment');
    expect(rendered.stdout).toContain('replicas: 4');
  });

  it('helm lint 认得出坏掉的 chart', async () => {
    const { vfs, helm } = bench();
    await helm(['create', 'portal']);
    const ok = await helm(['lint', './portal']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('0 chart(s) failed');

    vfs.writeFile('/root/portal/Chart.yaml', 'apiVersion: v2\n');   // 少了 name 与 version
    const broken = await helm(['lint', './portal']);
    expect(broken.code).not.toBe(0);
    expect(broken.stdout + broken.stderr).toContain('1 chart(s) failed');
  });

  it('helm install 真的把对象建进了集群', async () => {
    const { cluster, helm } = bench();
    await helm(['create', 'portal']);
    const installed = await helm(['install', 'portal', './portal']);
    expect(installed.stderr).toBe('');
    expect(installed.stdout).toContain('STATUS: deployed');

    await cluster.settle();
    expect(deploymentsOf(cluster).items.map((item) => item.metadata.name)).toEqual(['portal']);
  });

  it('helm list 的时间戳跟着虚拟时钟走 —— 换台机器重放也一样', async () => {
    const { helm } = bench();
    await helm(['create', 'portal']);
    await helm(['install', 'portal', './portal']);
    const list = await helm(['list']);
    expect(list.stdout).toContain('2026-03-02 09:00:00 +0000 UTC');
    expect(list.stdout).toContain('deployed');
  });

  it('helm upgrade 改得动已经在跑的东西', async () => {
    const { cluster, helm } = bench();
    await helm(['create', 'portal']);
    await helm(['install', 'portal', './portal']);
    await cluster.settle();

    const upgraded = await helm(['upgrade', 'portal', './portal', '--set', 'replicaCount=3']);
    expect(upgraded.stdout).toContain('REVISION: 2');
    await cluster.settle();

    const deployment = deploymentsOf(cluster).items[0];
    expect((deployment.spec as { replicas: number }).replicas).toBe(3);
    // 服务端 apply 记下了是谁写的
    const managed = (deployment.metadata as unknown as { managedFields?: Array<{ manager: string }> }).managedFields;
    expect(managed?.map((entry) => entry.manager)).toContain('helm');
  });

  it('helm uninstall 把建出来的东西收回去', async () => {
    const { cluster, helm } = bench();
    await helm(['create', 'portal']);
    await helm(['install', 'portal', './portal']);
    await cluster.settle();
    expect(deploymentsOf(cluster).items).toHaveLength(1);

    await helm(['uninstall', 'portal']);
    await cluster.settle();
    expect(deploymentsOf(cluster).items).toHaveLength(0);
  });

  it('同一串命令重放两遍，输出逐字节一致', async () => {
    const once = async () => {
      const { helm } = bench();
      await helm(['create', 'portal']);
      await helm(['install', 'portal', './portal']);
      return (await helm(['list'])).stdout;
    };
    expect(await once()).toBe(await once());
  });
});
