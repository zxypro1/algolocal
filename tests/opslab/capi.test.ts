/**
 * Cluster API
 *
 * 要钉住的三件：
 *   1. 形状和 Deployment 那一套对应：改副本数就是加机器
 *   2. 机器不是立刻就有的 —— Provisioning / Provisioned / Running 三段
 *   3. 删机器要先把 Node 和上面的 Pod 摘掉，缩容才不至于打断服务
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import { printerFor } from '../../src/lib/opslab/apiserver';
import { BOOTSTRAP_MS, PROVISION_MS } from '../../src/lib/opslab/capi';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const CAPI_IMAGE = 'registry.k8s.io/cluster-api/cluster-api-controller:v1.9.4';
const APP_IMAGE = 'registry.corp.internal/batch:1.0';

const MDS = { group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machinedeployments' } as const;
const MSS = { group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machinesets' } as const;
const MACHINES = { group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machines' } as const;
const NODES = { group: '', version: 'v1', resource: 'nodes' } as const;
const PODS = { group: '', version: 'v1', resource: 'pods' } as const;

const CAPI = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'capi-controller-manager', namespace: 'capi-system',
    labels: { 'app.kubernetes.io/name': 'cluster-api' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'cluster-api' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'cluster-api' } },
      spec: { containers: [{ name: 'manager', image: CAPI_IMAGE }] },
    },
  },
};

const TEMPLATE = {
  apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1', kind: 'VSphereMachineTemplate',
  metadata: { name: 'worker-medium', namespace: 'capi-system' },
  spec: { template: { spec: { numCPUs: 8, memoryMiB: 16384, diskGiB: 100 } } },
};

const machineDeployment = (replicas: number, templateName = 'worker-medium') => ({
  apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineDeployment',
  metadata: { name: 'workers', namespace: 'capi-system' },
  spec: {
    clusterName: 'corp',
    replicas,
    selector: { matchLabels: { pool: 'workers' } },
    template: {
      metadata: { labels: { pool: 'workers' } },
      spec: {
        clusterName: 'corp',
        version: 'v1.36.0',
        infrastructureRef: {
          apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1',
          kind: 'VSphereMachineTemplate', name: templateName,
        },
      },
    },
  },
});

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    nodes: [{ name: 'cp-1', cpu: '4', memory: '8Gi' }],
    namespaces: ['default', 'capi-system'],
    images: {
      [CAPI_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

async function build(objects: unknown[]) {
  const world = await createOpsWorld({ world: spec(objects) });
  await world.cluster.advanceBy(30_000);
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const listOf = (w: World, definition: any, namespace?: string) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(definition), namespace ? { namespace } : {}).items;
const machinesOf = (w: World) => listOf(w, MACHINES, 'capi-system');
const nodeNames = (w: World) => listOf(w, NODES).map((node) => node.metadata.name!).sort();
const isReady = (node: KubeObject) => ((node.status ?? {}) as any).conditions
  ?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True');

/**
 * 世界建好之后再声明机器。
 *
 * 放进初始对象里的话，建世界那一次 settle 会把装机时间一并走完，
 * 三段状态就看不见了 —— 而这三段正是这一层要教的东西。
 */
async function declare(w: World, replicas: number, templateName = 'worker-medium') {
  w.cluster.registry.create(
    w.cluster.scheme.mustGet(MDS), 'capi-system',
    machineDeployment(replicas, templateName) as unknown as KubeObject
  );
  await w.cluster.advanceBy(1_000);
}

describe('机器的一生', () => {
  it('声明三台，就真的出现三台，规格来自 infra 模板', async () => {
    const w = await build([CAPI, TEMPLATE]);
    await declare(w, 3);
    expect(machinesOf(w)).toHaveLength(3);
    // 刚声明出来的时候还在造，Node 一个都没有
    expect(machinesOf(w).every((m) => (m.status as any).phase === 'Provisioning')).toBe(true);
    expect(nodeNames(w)).toEqual(['cp-1']);

    await w.cluster.advanceBy(PROVISION_MS + 1000);
    // 机器起来了，但 kubelet 还没报到：Node 在，NotReady
    expect(nodeNames(w)).toHaveLength(4);
    expect(listOf(w, NODES).filter((node) => node.metadata.name !== 'cp-1').every(isReady)).toBe(false);
    expect(machinesOf(w).every((m) => (m.status as any).phase === 'Provisioned')).toBe(true);

    await w.cluster.advanceBy(BOOTSTRAP_MS + 1000);
    expect(machinesOf(w).every((m) => (m.status as any).phase === 'Running')).toBe(true);
    const workers = listOf(w, NODES).filter((node) => node.metadata.name !== 'cp-1');
    expect(workers.every(isReady)).toBe(true);
    // 8 核 16Gi 是模板上写的，不是 MachineDeployment 上写的
    expect((workers[0].status as any).capacity).toEqual({ cpu: '8', memory: '16Gi', pods: '110' });
  });

  it('控制器不在时，MachineDeployment 就只是一个对象', async () => {
    const w = await build([TEMPLATE, machineDeployment(3)]);
    await w.cluster.advanceBy(PROVISION_MS * 2);
    expect(machinesOf(w)).toHaveLength(0);
    expect(nodeNames(w)).toEqual(['cp-1']);
  });

  it('改副本数就是加机器', async () => {
    const w = await build([CAPI, TEMPLATE, machineDeployment(1)]);
    expect(nodeNames(w)).toHaveLength(2);

    const definition = w.cluster.scheme.mustGet(MDS);
    const live = w.cluster.registry.get(definition, 'capi-system', 'workers');
    w.cluster.registry.update(definition, 'capi-system', 'workers', {
      ...live, spec: { ...(live.spec as any), replicas: 3 },
    } as KubeObject);
    await w.cluster.advanceBy(PROVISION_MS + BOOTSTRAP_MS + 5_000);

    expect(machinesOf(w)).toHaveLength(3);
    expect(nodeNames(w)).toHaveLength(4);
  });

  /**
   * 缩容删的是**最新**那台。老机器上跑的东西更可能是已经稳定的，
   * 真 CAPI 的默认删除策略也是 Newest。
   */
  it('缩容：机器没了，节点跟着走，上面的 Pod 被重新调度', async () => {
    const w = await build([CAPI, TEMPLATE, machineDeployment(2)]);
    expect(nodeNames(w)).toHaveLength(3);

    w.cluster.registry.create(w.cluster.scheme.mustGet(
      { group: 'apps', version: 'v1', resource: 'deployments' }
    ), 'default', {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'batch', namespace: 'default' },
      spec: {
        replicas: 4,
        selector: { matchLabels: { app: 'batch' } },
        template: {
          metadata: { labels: { app: 'batch' } },
          spec: { containers: [{ name: 'app', image: APP_IMAGE }] },
        },
      },
    } as KubeObject);
    await w.cluster.advanceBy(60_000);
    const before = listOf(w, PODS, 'default').filter((pod) => (pod.status as any).phase === 'Running');
    expect(before).toHaveLength(4);

    const definition = w.cluster.scheme.mustGet(MDS);
    const live = w.cluster.registry.get(definition, 'capi-system', 'workers');
    w.cluster.registry.update(definition, 'capi-system', 'workers', {
      ...live, spec: { ...(live.spec as any), replicas: 1 },
    } as KubeObject);
    await w.cluster.advanceBy(120_000);

    expect(machinesOf(w)).toHaveLength(1);
    expect(nodeNames(w)).toHaveLength(2);
    // 服务没被打断：副本数还是 4，只是落在别处
    const after = listOf(w, PODS, 'default').filter((pod) => (pod.status as any).phase === 'Running');
    expect(after).toHaveLength(4);
  });

  it('换模板就是换一批机器', async () => {
    const big = {
      ...TEMPLATE,
      metadata: { name: 'worker-large', namespace: 'capi-system' },
      spec: { template: { spec: { numCPUs: 16, memoryMiB: 32768, diskGiB: 200 } } },
    };
    const w = await build([CAPI, TEMPLATE, big, machineDeployment(2)]);
    const oldNames = machinesOf(w).map((m) => m.metadata.name).sort();

    const definition = w.cluster.scheme.mustGet(MDS);
    const live = w.cluster.registry.get(definition, 'capi-system', 'workers');
    const nextSpec = JSON.parse(JSON.stringify(live.spec));
    nextSpec.template.spec.infrastructureRef.name = 'worker-large';
    w.cluster.registry.update(definition, 'capi-system', 'workers', { ...live, spec: nextSpec } as KubeObject);
    await w.cluster.advanceBy(PROVISION_MS + BOOTSTRAP_MS + 10_000);

    expect(machinesOf(w).map((m) => m.metadata.name).sort()).not.toEqual(oldNames);
    expect(listOf(w, MSS, 'capi-system')).toHaveLength(2);
    const workers = listOf(w, NODES).filter((node) => node.metadata.name !== 'cp-1');
    expect(workers).toHaveLength(2);
    expect((workers[0].status as any).capacity.cpu).toBe('16');
  });
});

describe('表格', () => {
  it('machine 的列跟 clusterctl 一致，NODENAME 在造机器的时候是空的', async () => {
    const w = await build([CAPI, TEMPLATE]);
    await declare(w, 1);
    const printer = printerFor('machines');
    expect(printer.columns.map((column) => column.name)).toEqual([
      'Name', 'Cluster', 'Nodename', 'Providerid', 'Phase', 'Age', 'Version',
    ]);
    expect(printer.cells(machinesOf(w)[0], '10s')[2]).toBe('');
    expect(printer.cells(machinesOf(w)[0], '10s')[4]).toBe('Provisioning');

    await w.cluster.advanceBy(PROVISION_MS + BOOTSTRAP_MS + 5_000);
    expect(printer.cells(machinesOf(w)[0], '3m')[2]).toBeTruthy();
    expect(printer.cells(machinesOf(w)[0], '3m')[4]).toBe('Running');
  });
});
