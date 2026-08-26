/**
 * cluster-autoscaler
 *
 * 要钉住的四件，每一件都对应一种「伸缩器装了但没用」：
 *   1. 没打 min/max 注解的机器组它看都不看
 *   2. 它只认调度器的结论：装不进任何一台新机器的 Pod，它一台都不加
 *   3. 缩容要等「闲得够久」，而且上面的 Pod 得挪得走
 *   4. safe-to-evict: "false" / 没有属主的 Pod / PDB，任何一个都能钉住一台机器
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import {
  BOOTSTRAP_MS, MAX_SIZE_ANNOTATION, MIN_SIZE_ANNOTATION, PROVISION_MS,
  SAFE_TO_EVICT_ANNOTATION, UNNEEDED_MS,
} from '../../src/lib/opslab/capi';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const CAPI_IMAGE = 'registry.k8s.io/cluster-api/cluster-api-controller:v1.9.4';
const CA_IMAGE = 'registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.0';
const APP_IMAGE = 'registry.corp.internal/batch:1.0';

const MDS = { group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machinedeployments' } as const;
const MACHINES = { group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machines' } as const;
const NODES = { group: '', version: 'v1', resource: 'nodes' } as const;
const PODS = { group: '', version: 'v1', resource: 'pods' } as const;
const DEPLOYMENTS = { group: 'apps', version: 'v1', resource: 'deployments' } as const;
const EVENTS = { group: '', version: 'v1', resource: 'events' } as const;

const platform = (name: string, image: string) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name, namespace: 'capi-system', labels: { 'app.kubernetes.io/name': name } },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': name } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': name } },
      spec: { containers: [{ name: 'manager', image }] },
    },
  },
});

const TEMPLATE = {
  apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1', kind: 'VSphereMachineTemplate',
  metadata: { name: 'worker', namespace: 'capi-system' },
  spec: { template: { spec: { numCPUs: 8, memoryMiB: 16384 } } },
};

const machineDeployment = (annotations?: Record<string, string>) => ({
  apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineDeployment',
  metadata: { name: 'workers', namespace: 'capi-system', ...(annotations ? { annotations } : {}) },
  spec: {
    clusterName: 'corp', replicas: 1,
    selector: { matchLabels: { pool: 'workers' } },
    template: {
      metadata: { labels: { pool: 'workers' } },
      spec: {
        clusterName: 'corp', version: 'v1.36.0',
        infrastructureRef: {
          apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1',
          kind: 'VSphereMachineTemplate', name: 'worker',
        },
      },
    },
  },
});

const MANAGED = {
  [MIN_SIZE_ANNOTATION]: '1',
  [MAX_SIZE_ANNOTATION]: '4',
};

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    // 控制面那台故意小：批处理放不上去，扩容才有意义
    nodes: [{ name: 'cp-1', cpu: '2', memory: '4Gi' }],
    namespaces: ['default', 'capi-system'],
    images: {
      [CAPI_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [CA_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

async function build(annotations?: Record<string, string>) {
  const world = await createOpsWorld({
    world: spec([
      platform('cluster-api', CAPI_IMAGE),
      platform('cluster-autoscaler', CA_IMAGE),
      TEMPLATE, machineDeployment(annotations),
    ]),
  });
  await world.cluster.advanceBy(30_000);
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const listOf = (w: World, definition: any, namespace?: string) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(definition), namespace ? { namespace } : {}).items;
const replicasOf = (w: World) =>
  ((w.cluster.registry.get(w.cluster.scheme.mustGet(MDS), 'capi-system', 'workers').spec ?? {}) as any).replicas;
const runningPods = (w: World) =>
  listOf(w, PODS, 'default').filter((pod) => (pod.status as any).phase === 'Running');
const messagesOn = (w: World, name: string) => listOf(w, EVENTS, 'default')
  .filter((event) => (event as any).involvedObject?.name?.startsWith(name))
  .map((event) => String((event as any).message));

/** 一批要 cpu 的 Pod */
function batch(w: World, name: string, replicas: number, cpu: string, extra: Record<string, unknown> = {}) {
  w.cluster.registry.create(w.cluster.scheme.mustGet(DEPLOYMENTS), 'default', {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: 'default' },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name }, ...(extra.podMetadata ?? {}) as object },
        spec: {
          containers: [{ name: 'app', image: APP_IMAGE, resources: { requests: { cpu } } }],
        },
      },
    },
  } as KubeObject);
}

/** 装机 + 一轮扫描 */
const settleFleet = (w: World, extra = 0) =>
  w.cluster.advanceBy(PROVISION_MS + BOOTSTRAP_MS + 30_000 + extra);

describe('扩容', () => {
  it('装不下就加机器，加到装得下为止', async () => {
    const w = await build(MANAGED);
    await settleFleet(w);
    expect(listOf(w, NODES)).toHaveLength(2);

    // 一台 8 核的机器装得下两个 3 核的 Pod，6 个要三台
    batch(w, 'settlement', 6, '3');
    await settleFleet(w);
    await settleFleet(w);

    expect(replicasOf(w)).toBe(3);
    expect(runningPods(w)).toHaveLength(6);
  });

  /**
   * 没打注解的机器组，伸缩器**看都不看**。
   * 「伸缩器装了但不工作」十次有九次是这个。
   */
  it('没打 min/max 注解：一台都不加', async () => {
    const w = await build();
    await settleFleet(w);
    batch(w, 'settlement', 6, '3');
    await settleFleet(w);
    await settleFleet(w);

    expect(replicasOf(w)).toBe(1);
    expect(runningPods(w).length).toBeLessThan(6);
  });

  /**
   * 请求比一整台机器还大的 Pod：加了也白加，所以它一台都不加。
   * 这不是坏了，是它算出来「加了没用」—— 而它会把这句话记成事件。
   */
  it('一台机器都装不下的 Pod：不加机器，但说得出为什么', async () => {
    const w = await build(MANAGED);
    await settleFleet(w);
    batch(w, 'reconciler', 1, '32');
    await settleFleet(w);
    await settleFleet(w);

    expect(replicasOf(w)).toBe(1);
    expect(messagesOn(w, 'reconciler').join('\n')).toContain('Insufficient cpu');
  });

  it('加到上限就停，并且说得出是撞了上限', async () => {
    const w = await build({ [MIN_SIZE_ANNOTATION]: '1', [MAX_SIZE_ANNOTATION]: '2' });
    await settleFleet(w);
    batch(w, 'settlement', 6, '3');
    await settleFleet(w);
    await settleFleet(w);

    expect(replicasOf(w)).toBe(2);
    expect(runningPods(w).length).toBeLessThan(6);
    expect(messagesOn(w, 'settlement').join('\n')).toContain('max node group size reached');
  });
});

describe('反应速度', () => {
  /**
   * Pod 一旦被判定为调度不上，伸缩器立刻就看 —— 不用等下一次定时扫描。
   * 真 CA 只有定时那一路，差别只是延迟；这里两路都有，因为这个世界的
   * 时间是被命令推着走的。
   */
  it('不用等定时扫描，Pod 挂在那儿就会触发扩容', async () => {
    const w = await build(MANAGED);
    await settleFleet(w);
    batch(w, 'settlement', 4, '3');
    // 只给刚够装机的时间，中间不留额外的扫描周期
    await w.cluster.advanceBy(PROVISION_MS + BOOTSTRAP_MS + 2_000);
    expect(replicasOf(w)).toBeGreaterThan(1);
  });
});

describe('缩容', () => {
  async function scaledUp() {
    const w = await build(MANAGED);
    await settleFleet(w);
    batch(w, 'settlement', 4, '3');
    await settleFleet(w);
    await settleFleet(w);
    expect(replicasOf(w)).toBeGreaterThan(1);
    return w;
  }

  it('活干完了机器要还回去，但要闲够时间才还', async () => {
    const w = await scaledUp();
    const peak = replicasOf(w);

    w.cluster.registry.delete(w.cluster.scheme.mustGet(DEPLOYMENTS), 'default', 'settlement');
    await w.cluster.advanceBy(60_000);
    // 刚闲下来还不能缩 —— 抖一下就回收机器，下一批活来了又得等装机
    expect(replicasOf(w)).toBe(peak);

    await w.cluster.advanceBy(UNNEEDED_MS + 60_000);
    await settleFleet(w);
    expect(replicasOf(w)).toBe(1);
    expect(listOf(w, MACHINES, 'capi-system')).toHaveLength(1);
  });

  /**
   * safe-to-evict: "false" 能把一台机器永远钉在那儿。
   * 「为什么半夜三点还有十台空机器」的答案通常就在这儿，
   * 而伸缩器本身是沉默的 —— 所以这里让它把原因说出来。
   */
  /**
   * safe-to-evict: "false" 能把一台机器永远钉在那儿。
   *
   * 这里把下限设成 0，好把「钉住」这件事单独拎出来：不然缩到下限就停了，
   * 分不清是被钉住还是撞了下限。「为什么半夜三点还有十台空机器」的答案
   * 通常就在这一条上，而伸缩器本身是沉默的 —— 所以要让它说得出话。
   */
  it('打了 safe-to-evict: "false" 的 Pod 钉住整台机器', async () => {
    const w = await build({ [MIN_SIZE_ANNOTATION]: '0', [MAX_SIZE_ANNOTATION]: '4' });
    await settleFleet(w);
    batch(w, 'settlement', 4, '3');
    await settleFleet(w);
    await settleFleet(w);
    expect(replicasOf(w)).toBeGreaterThan(1);

    w.cluster.registry.delete(w.cluster.scheme.mustGet(DEPLOYMENTS), 'default', 'settlement');
    await w.cluster.advanceBy(60_000);
    batch(w, 'pinned', 1, '100m', {
      podMetadata: { annotations: { [SAFE_TO_EVICT_ANNOTATION]: 'false' } },
    });
    await settleFleet(w);
    const pinnedNode = (listOf(w, PODS, 'default')[0].spec as any).nodeName;

    await w.cluster.advanceBy(UNNEEDED_MS + 60_000);
    await settleFleet(w);

    // 下限是 0，空机器全还回去了，钉住的那台还在
    expect(replicasOf(w)).toBe(1);
    expect(listOf(w, NODES).map((node) => node.metadata.name)).toContain(pinnedNode);
    const blocked = listOf(w, EVENTS)
      .map((event) => String((event as any).message))
      .filter((message) => message.includes('safe-to-evict'));
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('缩容还回去的是后加的那几台，不是随便少一台', async () => {
    const w = await scaledUp();
    const oldest = listOf(w, MACHINES, 'capi-system')
      .slice()
      .sort((a, b) => (a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? -1 : 1))[0];

    w.cluster.registry.delete(w.cluster.scheme.mustGet(DEPLOYMENTS), 'default', 'settlement');
    await w.cluster.advanceBy(UNNEEDED_MS + 60_000);
    await settleFleet(w);

    const left = listOf(w, MACHINES, 'capi-system');
    expect(left).toHaveLength(1);
    expect(left[0].metadata.name).toBe(oldest.metadata.name);
  });
});
