/**
 * ops 关卡的运行与判定
 *
 * 这一层要保证的是：判定读的世界就是学员操作的那个世界，
 * 拓扑与变更流是同一份状态的投影，隐藏用例跑出来的报告结构和代码关卡一致。
 */
import ts from 'typescript';
import { createOpsWorld, runOpsStage, buildTopology, snapshotVersions, diffVersions } from '../../src/lib/opslab/lab';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import type { OpsWorldSpec, SpecFile } from '../../src/lib/engineering/types';

/** 隐藏用例是 TS，和代码关卡一样要过一遍转译 */
const transpile = createTranspiler(ts);
const run = (world: Parameters<typeof runOpsStage>[0]['world'], specs: SpecFile[], caseWallClockMs?: number) =>
  runOpsStage({ world, specs, transpile, caseWallClockMs });

const NGINX = 'registry.corp.internal/portal:1.4';

const WORLD: OpsWorldSpec = {
  startTime: '2026-03-02T09:00:00Z',
  nodes: [{ name: 'node-1' }, { name: 'node-2' }],
  namespaces: ['default', 'kube-system'],
  images: { [NGINX]: { pullMs: 300, startupMs: 400, readyAfterMs: 200 } },
  registries: [{ host: 'harbor.corp.internal', users: { ci: 'pw' }, projects: ['team'] }],
  machine: { hostname: 'jump-01', files: { '/root/notes.md': 'hello\n' } },
};

const DEPLOYMENT = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'portal', namespace: 'default' },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: 'portal' } },
    template: {
      metadata: { labels: { app: 'portal' } },
      spec: { containers: [{ name: 'web', image: NGINX }] },
    },
  },
};

const SERVICE = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'portal', namespace: 'default' },
  spec: { selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
};

describe('世界装配', () => {
  it('节点与命名空间有合理的年龄 —— 接手的不是刚建好的集群', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const node = world.cluster.registry.get(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'nodes' }),
      undefined, 'node-1'
    );
    // 默认 32 天
    expect(node.metadata.creationTimestamp).toBe('2026-01-29T09:00:00Z');
  });

  it('按题目的世界定义把集群和机器接起来', async () => {
    const world = await createOpsWorld({ world: WORLD });
    expect(world.machine.hostname).toBe('jump-01');
    expect(world.machine.vfs.readFile('/root/notes.md')).toBe('hello\n');
    expect(world.now()).toBe(Date.parse('2026-03-02T09:00:00Z'));

    const nodes = world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'nodes' })
    );
    expect(nodes.items.map((node) => node.metadata.name)).toEqual(['node-1', 'node-2']);
  });

  it('初态对象走 registry，长得和 apply 出来的一样', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT, SERVICE] } });
    const deployment = world.cluster.registry.get(
      world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'default', 'portal'
    );
    expect(deployment.metadata.uid).toMatch(/^uid-/);
    // 初态对象是「本来就在」的，按 6 小时前建出来算，AGE 列才不会全是 0s
    expect(deployment.metadata.creationTimestamp).toBe('2026-03-02T03:00:00Z');
    // 控制器已经跑过了：Pod 起来了
    const pods = world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' })
    );
    expect(pods.items).toHaveLength(2);
    expect(pods.items.every((pod) => (pod.status as any).phase === 'Running')).toBe(true);
  });

  it('未注册的类型要当场报错，而不是悄悄少一个对象', async () => {
    await expect(createOpsWorld({
      world: WORLD,
      stage: { objects: [{ apiVersion: 'nope.io/v1', kind: 'Widget', metadata: { name: 'x' } }] },
    })).rejects.toThrow(/未注册的类型/);
  });

  it('setupCommands 布置现场，算世界的一部分而不是学员做的', async () => {
    const world = await createOpsWorld({
      world: WORLD,
      stage: { setupCommands: ['mkdir -p /root/infra', 'echo drift > /root/infra/note.txt'] },
    });
    expect(world.machine.vfs.readFile('/root/infra/note.txt')).toBe('drift\n');
  });

  it('docker 装好了，私有仓库连得上', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const login = await world.run('docker login harbor.corp.internal -u ci -p pw');
    expect(login.stdout).toContain('Login Succeeded');
    const denied = await world.run('docker login harbor.corp.internal -u ci -p wrong');
    expect(denied.stderr).toContain('401 Unauthorized');
  });
});

describe('隐藏用例（@ops/lab）', () => {
  const SPEC = `
import { get, list, sh, transcript, readFile } from '@ops/lab';

describe('第 2 关', () => {
  it('Deployment 有 2 个就绪副本', () => {
    const deployment = get('Deployment', 'portal');
    expect(deployment).toBeTruthy();
    expect(deployment.status.readyReplicas).toBe(2);
  });

  it('Service 的 selector 和 Pod 的标签对得上', () => {
    const pods = list('Pod', { labels: { app: 'portal' } });
    expect(pods.length).toBe(2);
  });

  it('平台自己敲一条命令来探测', async () => {
    const result = await sh('grep -c hello /root/notes.md');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('1' + String.fromCharCode(10));
  });

  it('看得到学员敲过什么', () => {
    expect(transcript().some((entry) => entry.command.includes('echo'))).toBe(true);
  });

  it('看得到机器上的文件', () => {
    expect(readFile('/root/notes.md')).toBe('hello\\n');
  });
});
`;

  it('跑出来的报告和代码关卡是同一种结构', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT, SERVICE] } });
    await world.run('echo hi');

    const report = await run(world, [{ path: 'stage.spec.ts', content: SPEC }]);

    expect(report.status).toBe('passed');
    expect(report.totals).toEqual({ total: 5, passed: 5, failed: 0 });
    expect(report.cases.map((item) => item.suite)).toEqual(Array(5).fill(['第 2 关']));
    expect(report.gates).toEqual([]);
    expect(report.metrics.virtualElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('判定读的就是学员操作过的那个世界', async () => {
    const world = await createOpsWorld({ world: WORLD });
    // 「学员」自己建的对象，判定必须看得见
    world.cluster.registry.create(
      world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'default', DEPLOYMENT as never
    );
    await world.cluster.settle();

    const report = await run(world, [{
      path: 'x.spec.ts',
      content: `import { get } from '@ops/lab';
it('看得见', () => { expect(get('Deployment', 'portal').status.readyReplicas).toBe(2); });`,
    }]);
    expect(report.status).toBe('passed');
  });

  it('断言失败会带上期望值与实际值', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const report = await run(world, [{
      path: 'x.spec.ts',
      content: `import { list } from '@ops/lab';
it('应该有 3 个 Pod', () => { expect(list('Pod').length).toBe(3); });`,
    }]);
    expect(report.status).toBe('failed');
    expect(report.cases[0].expected).toBe('3');
    expect(report.cases[0].actual).toBe('0');
  });

  it('spec 里的 console 进报告，不打到宿主控制台', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const report = await run(world, [{ path: 'x.spec.ts', content: `console.log('from spec'); it('ok', () => {});` }]);
    expect(report.console.map((entry) => entry.text)).toContain('from spec');
    expect(report.console[0].at).toBe(Date.parse('2026-03-02T09:00:00Z'));
  });

  it('spec 自己写死循环也要能停下来，不能把页面卡死', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const report = await run(
      world,
      [{ path: 'x.spec.ts', content: `it('卡住', async () => { await new Promise(() => {}); });` }],
      150
    );
    expect(report.status).toBe('failed');
    expect(report.cases[0].error).toMatch(/用例超时/);
  });
});

describe('拓扑投影', () => {
  it('泳道、坐标与连线', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT, SERVICE] } });
    const graph = buildTopology(world.cluster);

    expect(graph.lanes.map((lane) => lane.title)).toEqual(['入口', '工作负载', '实例', '节点']);
    expect(graph.nodes.filter((node) => node.kind === 'Pod')).toHaveLength(2);
    expect(graph.nodes.find((node) => node.kind === 'Deployment')).toMatchObject({
      detail: '2/2', status: 'ok', command: 'kubectl describe deployment portal -n default',
    });
    // ReplicaSet 默认折叠，Deployment 直接连到 Pod
    expect(graph.nodes.some((node) => node.kind === 'ReplicaSet')).toBe(false);
    expect(graph.edges.filter((edge) => edge.kind === 'owns')).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.kind === 'routes')).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.kind === 'schedules')).toHaveLength(2);
  });

  it('同样的状态画两次，位置逐字节一样', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT, SERVICE] } });
    expect(JSON.stringify(buildTopology(world.cluster)))
      .toBe(JSON.stringify(buildTopology(world.cluster)));
  });

  it('selector 写错了就没有 routes 连线 —— 一眼看得出来', async () => {
    const world = await createOpsWorld({
      world: WORLD,
      stage: {
        objects: [
          DEPLOYMENT,
          { ...SERVICE, spec: { ...SERVICE.spec, selector: { app: 'protal' } } },
        ],
      },
    });
    const graph = buildTopology(world.cluster);
    expect(graph.edges.filter((edge) => edge.kind === 'routes')).toHaveLength(0);
  });

  it('变过的节点会被标出来', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT] } });
    const before = buildTopology(world.cluster);
    const deployments = world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' });
    world.cluster.registry.setScale(deployments, 'default', 'portal',
      { apiVersion: 'autoscaling/v1', kind: 'Scale', metadata: { name: 'portal' }, spec: { replicas: 1 } } as never);
    await world.cluster.settle();

    const after = buildTopology(world.cluster, { previous: before });
    const deployment = after.nodes.find((node) => node.kind === 'Deployment');
    expect(deployment).toMatchObject({ detail: '1/1', changed: true });
    // 节点没变的不该被标红
    expect(after.nodes.find((node) => node.kind === 'Node')?.changed).toBe(false);
  });

  it('showReplicaSets 打开之后中间层才出现', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT] } });
    const graph = buildTopology(world.cluster, { showReplicaSets: true });
    expect(graph.nodes.some((node) => node.kind === 'ReplicaSet')).toBe(true);
  });
});

describe('变更流', () => {
  it('两张快照之间的增删改', async () => {
    const world = await createOpsWorld({ world: WORLD });
    const before = snapshotVersions(world.cluster);

    world.cluster.registry.create(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'namespaces' }),
      undefined,
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'payments' } } as never
    );
    await world.cluster.settle();
    const after = snapshotVersions(world.cluster);

    const changes = diffVersions(before, after, world.now());
    expect(changes.some((change) => change.type === 'added' && change.kind === 'Namespace'
      && change.name === 'payments')).toBe(true);
  });

  it('删除也算一条', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [SERVICE] } });
    const before = snapshotVersions(world.cluster);
    world.cluster.registry.delete(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'services' }),
      'default', 'portal'
    );
    await world.cluster.settle();
    const changes = diffVersions(before, snapshotVersions(world.cluster), world.now());
    expect(changes).toContainEqual(expect.objectContaining({
      type: 'deleted', kind: 'Service', name: 'portal',
    }));
  });

  it('Event 不算变更 —— 它本来就是变更记录，再算一遍是自我指涉的噪音', async () => {
    const world = await createOpsWorld({ world: WORLD, stage: { objects: [DEPLOYMENT] } });
    const snapshot = snapshotVersions(world.cluster);
    expect([...snapshot.keys()].some((key) => key.startsWith('Event/'))).toBe(false);
  });
});
