/**
 * 控制器的回归测试
 *
 * 重点是**因果链**：apply 一个 Deployment → 长出 ReplicaSet → 长出 Pod →
 * 被调度 → 变 Running → 变 Ready → 进 Service 的端点。
 * 这条链是四块面板里学员看到的第一个「东西自己动起来了」。
 */
import { createCluster, Cluster, DEPLOYMENTS, ENDPOINTS, EVENTS, PODS, REPLICASETS, SERVICES, NODES, isPodReady, parseCpu, resolveCount, templateHash } from '../../src/lib/opslab/controllers';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const IMAGES = {
  'registry.corp.internal/web:1.0': { pullMs: 100, startupMs: 200, readyAfterMs: 100 },
  'registry.corp.internal/web:2.0': { pullMs: 100, startupMs: 200, readyAfterMs: 100 },
  'registry.corp.internal/needs-db:1.0': { needsEnv: ['DB_PASSWORD'] },
};

function newCluster(overrides: Parameters<typeof createCluster>[0] = {}): Cluster {
  const cluster = createCluster({ images: IMAGES, ...overrides });
  cluster.start();
  return cluster;
}

function deployment(name: string, replicas = 3, image = 'registry.corp.internal/web:1.0'): KubeObject {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name: 'app', image, resources: { requests: { cpu: '100m' } } }] },
      },
    },
  };
}

const podsOf = (cluster: Cluster, ns = 'default') =>
  cluster.registry.list(PODS, { namespace: ns }).items;

describe('世界的初态', () => {
  it('命名空间与节点就位，节点是 Ready 的', async () => {
    const cluster = newCluster();
    await cluster.settle();
    const nodes = cluster.registry.list(NODES, {}).items;
    expect(nodes.map((n) => n.metadata.name)).toEqual(['node-1', 'node-2', 'node-3']);
    expect((nodes[0].status as any).conditions[0]).toMatchObject({ type: 'Ready', status: 'True' });
  });
});

describe('Deployment → ReplicaSet → Pod 这条因果链', () => {
  it('apply 一个 Deployment 之后，Pod 会自己长出来并变成 Ready', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();

    const replicaSets = cluster.registry.list(REPLICASETS, { namespace: 'default' }).items;
    expect(replicaSets).toHaveLength(1);
    expect(replicaSets[0].metadata.ownerReferences?.[0].kind).toBe('Deployment');

    const pods = podsOf(cluster);
    expect(pods).toHaveLength(3);
    expect(pods.every((pod) => (pod.status as any).phase === 'Running')).toBe(true);
    expect(pods.every(isPodReady)).toBe(true);
    expect(pods.every((pod) => (pod.spec as any).nodeName)).toBe(true);

    const deploy = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
    expect(deploy.status).toMatchObject({ replicas: 3, readyReplicas: 3, availableReplicas: 3 });
    expect((deploy.status as any).observedGeneration).toBe(deploy.metadata.generation);
  });

  it('ReplicaSet 的名字带模板哈希，Pod 名字带 RS 名', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 1));
    await cluster.settle();

    const rs = cluster.registry.list(REPLICASETS, { namespace: 'default' }).items[0];
    expect(rs.metadata.name).toMatch(/^web-[a-z0-9]{6}$/);
    expect(podsOf(cluster)[0].metadata.name.startsWith(`${rs.metadata.name}-`)).toBe(true);
  });

  it('扩容与缩容', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 2));
    await cluster.settle();
    expect(podsOf(cluster)).toHaveLength(2);

    const current = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
    cluster.registry.update(DEPLOYMENTS, 'default', 'web', {
      ...current, spec: { ...(current.spec as any), replicas: 5 },
    });
    await cluster.settle();
    expect(podsOf(cluster)).toHaveLength(5);

    const grown = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
    cluster.registry.update(DEPLOYMENTS, 'default', 'web', {
      ...grown, spec: { ...(grown.spec as any), replicas: 1 },
    });
    await cluster.settle();
    expect(podsOf(cluster).filter((p) => !p.metadata.deletionTimestamp)).toHaveLength(1);
  });

  it('删掉一个 Pod，ReplicaSet 会补回来 —— 自愈', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();
    const victim = podsOf(cluster)[0];

    cluster.registry.delete(PODS, 'default', victim.metadata.name);
    await cluster.settle();

    const after = podsOf(cluster);
    expect(after).toHaveLength(3);
    expect(after.map((p) => p.metadata.name)).not.toContain(victim.metadata.name);
    expect(after.every(isPodReady)).toBe(true);
  });
});

describe('调度器', () => {
  it('Pod 被分散到不同节点（least-allocated）', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();
    const nodes = podsOf(cluster).map((pod) => (pod.spec as any).nodeName);
    expect(new Set(nodes).size).toBe(3);
  });

  it('资源不够时 Pod 卡在 Pending 并给出 Unschedulable 的原因', async () => {
    const cluster = newCluster({ nodes: [{ name: 'tiny', cpu: '100m' }] });
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();

    const pods = podsOf(cluster);
    const scheduled = pods.filter((pod) => (pod.spec as any).nodeName);
    expect(scheduled).toHaveLength(1);                    // 只装得下一个

    const pending = pods.filter((pod) => !(pod.spec as any).nodeName);
    expect(pending.length).toBeGreaterThan(0);
    expect((pending[0].status as any).conditions[0]).toMatchObject({
      type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
    });
  });

  it('cordon 过的节点不接新 Pod', async () => {
    const cluster = newCluster({ nodes: [{ name: 'a' }, { name: 'b', unschedulable: true }] });
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();
    const nodes = new Set(podsOf(cluster).map((pod) => (pod.spec as any).nodeName));
    expect(nodes).toEqual(new Set(['a']));
  });

  it('nodeSelector 生效', async () => {
    const cluster = newCluster({
      nodes: [{ name: 'ssd', labels: { disk: 'ssd' } }, { name: 'hdd', labels: { disk: 'hdd' } }],
    });
    const deploy = deployment('web', 2);
    (deploy.spec as any).template.spec.nodeSelector = { disk: 'ssd' };
    cluster.registry.create(DEPLOYMENTS, 'default', deploy);
    await cluster.settle();
    expect(new Set(podsOf(cluster).map((p) => (p.spec as any).nodeName))).toEqual(new Set(['ssd']));
  });
});

describe('kubelet', () => {
  it('拉不到的镜像进 ImagePullBackOff，并记一条 Warning 事件', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 1, 'registry.corp.internal/nope:9.9'));
    await cluster.settle();

    const pod = podsOf(cluster)[0];
    expect((pod.status as any).containerStatuses[0].state.waiting.reason).toBe('ImagePullBackOff');
    expect(isPodReady(pod)).toBe(false);

    const events = cluster.registry.list(EVENTS, { namespace: 'default' }).items;
    const failed = events.find((e) => (e as any).reason === 'Failed');
    expect((failed as any)?.message).toContain('Failed to pull image');
  });

  it('缺环境变量进 CrashLoopBackOff', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('api', 1, 'registry.corp.internal/needs-db:1.0'));
    await cluster.settle();

    const pod = podsOf(cluster)[0];
    const state = (pod.status as any).containerStatuses[0];
    expect(state.state.waiting.reason).toBe('CrashLoopBackOff');
    expect(state.lastState.terminated.exitCode).toBe(1);
  });

  it('给了环境变量就能起来', async () => {
    const cluster = newCluster();
    const deploy = deployment('api', 1, 'registry.corp.internal/needs-db:1.0');
    (deploy.spec as any).template.spec.containers[0].env = [{ name: 'DB_PASSWORD', value: 's3cret' }];
    cluster.registry.create(DEPLOYMENTS, 'default', deploy);
    await cluster.settle();
    expect(isPodReady(podsOf(cluster)[0])).toBe(true);
  });

  it('Pod 拿到 IP，且同一个世界重放时 IP 一样', async () => {
    const ips = async () => {
      const cluster = newCluster();
      cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
      await cluster.settle();
      return podsOf(cluster).map((p) => (p.status as any).podIP).sort();
    };
    const first = await ips();
    expect(first.every((ip) => /^10\.42\.\d+\.\d+$/.test(ip))).toBe(true);
    expect(await ips()).toEqual(first);
  });

  it('生命周期是逐步推进的，不是一步到位', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 1));
    // 只推进到刚够创建容器，还不够 Running
    await cluster.advanceBy(150);
    const mid = podsOf(cluster)[0];
    expect((mid.status as any).phase).toBe('Pending');
    expect((mid.status as any).containerStatuses?.[0].state.waiting.reason).toBe('ContainerCreating');

    await cluster.settle();
    expect(isPodReady(podsOf(cluster)[0])).toBe(true);
  });
});

describe('Endpoints', () => {
  const service = (name: string, selector: Record<string, string>): KubeObject => ({
    apiVersion: 'v1', kind: 'Service',
    metadata: { name },
    spec: { selector, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], clusterIP: '10.96.0.10' },
  });

  it('只收 Ready 的 Pod', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 2));
    cluster.registry.create(SERVICES, 'default', service('web', { app: 'web' }));
    await cluster.settle();

    const endpoints = cluster.registry.get(ENDPOINTS, 'default', 'web');
    expect((endpoints as any).subsets[0].addresses).toHaveLength(2);
    expect((endpoints as any).subsets[0].ports[0]).toMatchObject({ port: 8080, protocol: 'TCP' });
  });

  it('Pod 起不来时端点是空的 —— 探针配错导致 502 的根', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 2, 'registry.corp.internal/nope:9.9'));
    cluster.registry.create(SERVICES, 'default', service('web', { app: 'web' }));
    await cluster.settle();

    const endpoints = cluster.registry.get(ENDPOINTS, 'default', 'web');
    expect((endpoints as any).subsets).toEqual([]);
  });

  it('选不中任何 Pod 的 Service 端点为空', async () => {
    const cluster = newCluster();
    cluster.registry.create(SERVICES, 'default', service('orphan', { app: 'nothing' }));
    await cluster.settle();
    expect((cluster.registry.get(ENDPOINTS, 'default', 'orphan') as any).subsets).toEqual([]);
  });

  it('Service 删掉之后 Endpoints 跟着走', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 1));
    cluster.registry.create(SERVICES, 'default', service('web', { app: 'web' }));
    await cluster.settle();
    expect(() => cluster.registry.get(ENDPOINTS, 'default', 'web')).not.toThrow();

    cluster.registry.delete(SERVICES, 'default', 'web');
    await cluster.settle();
    expect(() => cluster.registry.get(ENDPOINTS, 'default', 'web')).toThrow(/not found/);
  });
});

describe('滚动更新', () => {
  it('换镜像会建新 ReplicaSet，最终旧的缩到 0', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
    await cluster.settle();
    const firstRs = cluster.registry.list(REPLICASETS, { namespace: 'default' }).items[0];

    const current = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
    const spec = current.spec as any;
    spec.template.spec.containers[0].image = 'registry.corp.internal/web:2.0';
    cluster.registry.update(DEPLOYMENTS, 'default', 'web', { ...current, spec });
    await cluster.settle();

    const replicaSets = cluster.registry.list(REPLICASETS, { namespace: 'default' }).items;
    expect(replicaSets).toHaveLength(2);
    const oldRs = replicaSets.find((rs) => rs.metadata.uid === firstRs.metadata.uid)!;
    const newRs = replicaSets.find((rs) => rs.metadata.uid !== firstRs.metadata.uid)!;
    expect((oldRs.spec as any).replicas).toBe(0);
    expect((newRs.spec as any).replicas).toBe(3);

    const pods = podsOf(cluster).filter((p) => !p.metadata.deletionTimestamp);
    expect(pods).toHaveLength(3);
    expect(pods.every((p) => (p.spec as any).containers[0].image === 'registry.corp.internal/web:2.0')).toBe(true);
  });

  it('滚动更新期间可用副本数不掉到 maxUnavailable 线下', async () => {
    const cluster = newCluster();
    cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 4));
    await cluster.settle();

    const current = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
    const spec = current.spec as any;
    spec.strategy = { rollingUpdate: { maxSurge: 1, maxUnavailable: 1 } };
    spec.template.spec.containers[0].image = 'registry.corp.internal/web:2.0';
    cluster.registry.update(DEPLOYMENTS, 'default', 'web', { ...current, spec });

    // 一小步一小步推进，全程盯着可用副本数
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60; i += 1) {
      await cluster.advanceBy(100);
      const ready = podsOf(cluster).filter((p) => isPodReady(p) && !p.metadata.deletionTimestamp).length;
      worst = Math.min(worst, ready);
      const deploy = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
      if ((deploy.status as any).updatedReplicas === 4 && (deploy.status as any).readyReplicas === 4) break;
    }
    expect(worst).toBeGreaterThanOrEqual(3);            // 4 - maxUnavailable(1)
  });
});

describe('工具函数', () => {
  it('parseCpu', () => {
    expect(parseCpu('500m')).toBe(500);
    expect(parseCpu('2')).toBe(2000);
    expect(parseCpu(undefined)).toBe(0);
  });

  it('resolveCount 支持百分比与绝对值', () => {
    expect(resolveCount('25%', 4, 1)).toBe(1);
    expect(resolveCount('50%', 4, 1)).toBe(2);
    expect(resolveCount(2, 4, 1)).toBe(2);
  });

  it('templateHash 确定且区分不同模板', () => {
    const a = { spec: { containers: [{ image: 'x' }] } };
    const b = { spec: { containers: [{ image: 'y' }] } };
    expect(templateHash(a)).toBe(templateHash(a));
    expect(templateHash(a)).not.toBe(templateHash(b));
    expect(templateHash(a)).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('确定性', () => {
  it('同一个世界重放 20 次，最终状态逐字节一致', async () => {
    const run = async () => {
      const cluster = newCluster();
      cluster.registry.create(DEPLOYMENTS, 'default', deployment('web', 3));
      cluster.registry.create(SERVICES, 'default', {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: 'web' },
        spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 8080 }], clusterIP: '10.96.0.10' },
      });
      await cluster.settle();
      // 再来一次扰动，让控制器多跑几轮
      const deploy = cluster.registry.get(DEPLOYMENTS, 'default', 'web');
      cluster.registry.update(DEPLOYMENTS, 'default', 'web', {
        ...deploy, spec: { ...(deploy.spec as any), replicas: 5 },
      });
      await cluster.settle();

      return JSON.stringify({
        pods: podsOf(cluster).map((p) => ({
          name: p.metadata.name, node: (p.spec as any).nodeName,
          phase: (p.status as any).phase, ip: (p.status as any).podIP, ready: isPodReady(p),
        })),
        endpoints: (cluster.registry.get(ENDPOINTS, 'default', 'web') as any).subsets,
        deployment: cluster.registry.get(DEPLOYMENTS, 'default', 'web').status,
      }, null, 1);
    };

    const first = await run();
    expect(first).toContain('"ready": true');
    for (let i = 0; i < 19; i += 1) expect(await run()).toBe(first);
  }, 60_000);
});

/**
 * ClusterIP 的分配
 *
 * 这件事发生在 apiserver 里，不是控制器事后补的 —— 学员 `kubectl expose`
 * 完马上 `kubectl get svc`，IP 必须已经在那儿。
 */
describe('ClusterIP 分配器', () => {
  function svc(name: string, extra: Record<string, unknown> = {}) {
    return {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name, namespace: 'default' },
      spec: { selector: { app: name }, ports: [{ port: 80 }], ...extra },
    };
  }

  function fresh() {
    const cluster = createCluster();
    cluster.start();
    return cluster;
  }

  it('创建时就有 IP，而且在 service CIDR 里', () => {
    const cluster = fresh();
    const created = cluster.registry.create(SERVICES, 'default', svc('portal') as never);
    const ip = (created.spec as { clusterIP: string }).clusterIP;
    expect(ip).toMatch(/^10\.(9[6-9]|10\d|11[01])\.\d+\.\d+$/);
    expect((created.spec as { clusterIPs: string[] }).clusterIPs).toEqual([ip]);
  });

  it('同一个名字在两个世界里拿到同一个 IP —— 重放要可复现', () => {
    const a = fresh();
    const b = fresh();
    const ipA = (a.registry.create(SERVICES, 'default', svc('portal') as never).spec as any).clusterIP;
    const ipB = (b.registry.create(SERVICES, 'default', svc('portal') as never).spec as any).clusterIP;
    expect(ipA).toBe(ipB);
  });

  it('不同 Service 不撞车', () => {
    const cluster = fresh();
    const seen = new Set<string>();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const created = cluster.registry.create(SERVICES, 'default', svc(name) as never);
      seen.add((created.spec as any).clusterIP);
    }
    expect(seen.size).toBe(8);
  });

  it('headless 不分配', () => {
    const cluster = fresh();
    const created = cluster.registry.create(SERVICES, 'default', svc('db', { clusterIP: 'None' }) as never);
    expect((created.spec as any).clusterIP).toBe('None');
  });

  it('ExternalName 不分配 —— 它就是个 CNAME', () => {
    const cluster = fresh();
    const created = cluster.registry.create(
      SERVICES, 'default',
      { apiVersion: 'v1', kind: 'Service', metadata: { name: 'legacy', namespace: 'default' },
        spec: { type: 'ExternalName', externalName: 'legacy.corp.internal' } } as never
    );
    expect((created.spec as any).clusterIP).toBeUndefined();
  });

  it('关卡写死的 IP 不被改掉', () => {
    const cluster = fresh();
    const created = cluster.registry.create(SERVICES, 'default', svc('portal', { clusterIP: '10.96.1.10' }) as never);
    expect((created.spec as any).clusterIP).toBe('10.96.1.10');
  });

  it('整体替换时不换 VIP —— ClusterIP 是不可变字段', () => {
    const cluster = fresh();
    const created = cluster.registry.create(SERVICES, 'default', svc('portal') as never);
    const ip = (created.spec as any).clusterIP;
    const replaced = cluster.registry.update(SERVICES, 'default', 'portal', {
      apiVersion: 'v1', kind: 'Service', metadata: { name: 'portal', namespace: 'default' },
      spec: { selector: { app: 'portal' }, ports: [{ port: 8080 }] },
    } as never);
    expect((replaced.spec as any).clusterIP).toBe(ip);
  });
});
