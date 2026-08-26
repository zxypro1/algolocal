/**
 * 持久化存储
 *
 * 要钉住的核心只有一句：**数据不属于 Pod**。
 *
 * 围着它的是四件容易搞错的事：动态供给要有人干活（CSI 驱动是工作负载，
 * 不是控制面自带）、PVC 没绑上 Pod 就不该被调度、回收策略决定删了 PVC
 * 之后数据还在不在、以及 Retain 留下的 PV **不会**被下一个 PVC 自动接手。
 */
import { createExecHandler, createOpsWorld } from '../../src/lib/opslab/lab';
import { printerFor } from '../../src/lib/opslab/apiserver';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const APP_IMAGE = 'registry.corp.internal/ledger:3.2';
const CSI_IMAGE = 'registry.k8s.io/sig-storage/csi-provisioner:v5.1.0';

const PVCS = { group: '', version: 'v1', resource: 'persistentvolumeclaims' } as const;
const PVS = { group: '', version: 'v1', resource: 'persistentvolumes' } as const;
const PODS = { group: '', version: 'v1', resource: 'pods' } as const;

/** CSI 驱动：和别的平台组件一样，是集群里的一个工作负载 */
const CSI_DRIVER = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'csi-provisioner', namespace: 'kube-system',
    labels: { 'app.kubernetes.io/name': 'csi-driver' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'csi-driver' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'csi-driver' } },
      spec: { containers: [{ name: 'provisioner', image: CSI_IMAGE }] },
    },
  },
};

const CLASS = {
  apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
  metadata: {
    name: 'standard',
    annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
  },
  provisioner: 'csi.corp.internal',
  reclaimPolicy: 'Delete',
  volumeBindingMode: 'Immediate',
};

const claim = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
  metadata: { name: 'data', namespace: 'shop' },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: '5Gi' } },
    ...overrides,
  },
});

const pod = (claimName = 'data') => ({
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name: 'ledger', namespace: 'shop' },
  spec: {
    containers: [{
      name: 'app', image: APP_IMAGE,
      volumeMounts: [{ name: 'data', mountPath: '/data' }],
    }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName } }],
  },
});

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    namespaces: ['default', 'shop', 'kube-system'],
    images: {
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [CSI_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

async function build(objects: unknown[]) {
  const world = await createOpsWorld({ world: spec(objects) });
  await world.cluster.advanceBy(60_000);
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const pvcOf = (w: World, name = 'data') =>
  w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'shop', name);
const pvsOf = (w: World) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(PVS), {}).items;
const eventsOn = (w: World, name: string) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(
    { group: '', version: 'v1', resource: 'events' }
  ), { namespace: 'shop' }).items
    .filter((event) => (event as any).involvedObject?.name === name)
    .map((event) => String((event as any).message));

describe('绑定与供给', () => {
  it('有 StorageClass 又有驱动：盘自己造出来并绑上', async () => {
    const w = await build([CSI_DRIVER, CLASS, claim()]);
    const pvc = pvcOf(w);
    expect((pvc.status as any).phase).toBe('Bound');
    expect((pvc.spec as any).volumeName).toMatch(/^pvc-/);

    const pv = pvsOf(w)[0];
    expect((pv.status as any).phase).toBe('Bound');
    expect((pv.spec as any).claimRef).toMatchObject({ namespace: 'shop', name: 'data' });
    expect((pv.spec as any).persistentVolumeReclaimPolicy).toBe('Delete');
  });

  /**
   * 动态供给是工作负载干的活，不是控制面自带的。
   * 把驱动停掉，所有对象看起来都正常，PVC 就是一直 Pending —— 真集群里
   * 这条最难查，所以事件里必须说得出「在等谁」。
   */
  it('驱动不在：PVC 一直 Pending，而且说得出在等谁', async () => {
    const w = await build([CLASS, claim()]);
    expect((pvcOf(w).status as any).phase).toBe('Pending');
    expect(pvsOf(w)).toHaveLength(0);
    expect(eventsOn(w, 'data').join('\n')).toContain('external provisioner "csi.corp.internal"');
  });

  it('静态绑定不需要驱动：管理员建好的盘照样绑得上', async () => {
    const w = await build([
      CLASS,
      {
        apiVersion: 'v1', kind: 'PersistentVolume',
        metadata: { name: 'nfs-01' },
        spec: {
          capacity: { storage: '10Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'standard',
        },
      },
      claim(),
    ]);
    expect((pvcOf(w).spec as any).volumeName).toBe('nfs-01');
    expect((pvcOf(w).status as any).capacity).toEqual({ storage: '10Gi' });
  });

  it('盘太小或者访问模式不对就不绑，而不是勉强绑上', async () => {
    const w = await build([
      CLASS,
      {
        apiVersion: 'v1', kind: 'PersistentVolume',
        metadata: { name: 'tiny' },
        spec: {
          capacity: { storage: '1Gi' }, accessModes: ['ReadWriteOnce'],
          storageClassName: 'standard',
        },
      },
      {
        apiVersion: 'v1', kind: 'PersistentVolume',
        metadata: { name: 'readonly' },
        spec: {
          capacity: { storage: '50Gi' }, accessModes: ['ReadOnlyMany'],
          storageClassName: 'standard',
        },
      },
      claim(),
    ]);
    expect((pvcOf(w).status as any).phase).toBe('Pending');
  });

  /**
   * `storageClassName: ""` 和不写这个字段，差一对引号，行为完全相反：
   * 空串是**明确要求静态绑定**，不写才是用默认类。
   */
  it('storageClassName 写空串就是不要动态供给', async () => {
    const w = await build([CSI_DRIVER, CLASS, claim({ storageClassName: '' })]);
    expect((pvcOf(w).status as any).phase).toBe('Pending');
    expect(pvsOf(w)).toHaveLength(0);
  });

  it('WaitForFirstConsumer：没有 Pod 用它就先不造', async () => {
    const late = { ...CLASS, metadata: { ...CLASS.metadata, name: 'late' }, volumeBindingMode: 'WaitForFirstConsumer' };
    const w = await build([CSI_DRIVER, late, claim({ storageClassName: 'late' })]);
    expect((pvcOf(w).status as any).phase).toBe('Pending');
    expect(eventsOn(w, 'data').join('\n')).toContain('waiting for first consumer');

    w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', pod() as KubeObject);
    await w.cluster.advanceBy(60_000);
    expect((pvcOf(w).status as any).phase).toBe('Bound');
  });
});

describe('数据的生命周期', () => {
  async function withData() {
    const w = await build([CSI_DRIVER, CLASS, claim(), pod()]);
    const exec = createExecHandler(w.cluster);
    await exec(
      { namespace: 'shop', pod: 'ledger', command: ['sh', '-c', 'echo balance=42 > /data/ledger.txt'], stdin: false, tty: false },
      ''
    );
    return { w, exec };
  }

  it('写进挂载点的东西留在卷上，Pod 重建照样读得到', async () => {
    const { w } = await withData();
    const volumeName = (pvcOf(w).spec as any).volumeName;
    expect(w.cluster.volumes.read(volumeName)).toEqual({ 'ledger.txt': 'balance=42\n' });

    // 把 Pod 删掉重建：数据不属于 Pod
    w.cluster.registry.delete(w.cluster.scheme.mustGet(PODS), 'shop', 'ledger');
    await w.cluster.advanceBy(30_000);
    w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', pod() as KubeObject);
    await w.cluster.advanceBy(60_000);

    const again = await createExecHandler(w.cluster)(
      { namespace: 'shop', pod: 'ledger', command: ['cat', '/data/ledger.txt'], stdin: false, tty: false },
      ''
    );
    expect(again.stdout).toBe('balance=42\n');
  });

  it('容器根文件系统上的东西不留', async () => {
    const { w, exec } = await withData();
    await exec(
      { namespace: 'shop', pod: 'ledger', command: ['sh', '-c', 'echo scratch > /tmp/note'], stdin: false, tty: false },
      ''
    );
    const again = await exec(
      { namespace: 'shop', pod: 'ledger', command: ['cat', '/tmp/note'], stdin: false, tty: false },
      ''
    );
    expect(again.code).not.toBe(0);
  });

  /**
   * `Delete` 是连数据一起删。
   * 生产上这条最疼：删一个 release 顺手带走 PVC，盘就没了，
   * 而 apiserver 里再也查不到它存在过。
   */
  it('回收策略 Delete：PVC 一没，盘和数据一起没', async () => {
    const { w } = await withData();
    const volumeName = (pvcOf(w).spec as any).volumeName;
    w.cluster.registry.delete(w.cluster.scheme.mustGet(PODS), 'shop', 'ledger');
    w.cluster.registry.delete(w.cluster.scheme.mustGet(PVCS), 'shop', 'data');
    await w.cluster.advanceBy(30_000);

    expect(pvsOf(w)).toHaveLength(0);
    expect(w.cluster.volumes.read(volumeName)).toEqual({});
  });

  it('回收策略 Retain：盘和数据都留着，但下一个 PVC 接不走', async () => {
    const retain = { ...CLASS, metadata: { ...CLASS.metadata, name: 'keep' }, reclaimPolicy: 'Retain' };
    const w = await build([CSI_DRIVER, retain, claim({ storageClassName: 'keep' }), pod()]);
    await createExecHandler(w.cluster)(
      { namespace: 'shop', pod: 'ledger', command: ['sh', '-c', 'echo keep-me > /data/x'], stdin: false, tty: false },
      ''
    );
    const volumeName = (pvcOf(w).spec as any).volumeName;

    w.cluster.registry.delete(w.cluster.scheme.mustGet(PODS), 'shop', 'ledger');
    w.cluster.registry.delete(w.cluster.scheme.mustGet(PVCS), 'shop', 'data');
    await w.cluster.advanceBy(30_000);

    expect((pvsOf(w)[0].status as any).phase).toBe('Released');
    expect(w.cluster.volumes.read(volumeName)).toEqual({ x: 'keep-me\n' });

    // 新 PVC 接不走：claimRef 还挂在上面
    w.cluster.registry.create(
      w.cluster.scheme.mustGet(PVCS), 'shop',
      claim({ storageClassName: 'keep' }) as KubeObject
    );
    await w.cluster.advanceBy(30_000);
    expect((pvcOf(w).spec as any).volumeName).not.toBe(volumeName);
  });
});

describe('删命名空间', () => {
  /**
   * 一条命令带走整个环境。
   *
   * `kubectl delete namespace` 会把里面的东西全部删掉，包括 PVC ——
   * 而回收策略是 Delete 的话，盘和数据也跟着走。第 21 关的灾难就是这一条。
   */
  it('命名空间没了，里面的 PVC 和盘上的数据一起没', async () => {
    const w = await build([CSI_DRIVER, CLASS, claim(), pod()]);
    await createExecHandler(w.cluster)(
      { namespace: 'shop', pod: 'ledger', command: ['sh', '-c', 'echo gone > /data/x'], stdin: false, tty: false },
      ''
    );
    const volumeName = (pvcOf(w).spec as any).volumeName;
    expect(w.cluster.volumes.read(volumeName)).toEqual({ x: 'gone\n' });

    w.cluster.registry.delete(
      w.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'namespaces' }), undefined, 'shop'
    );
    await w.cluster.advanceBy(30_000);

    expect(w.cluster.registry.list(w.cluster.scheme.mustGet(PVCS), { namespace: 'shop' }).items)
      .toHaveLength(0);
    expect(pvsOf(w)).toHaveLength(0);
    expect(w.cluster.volumes.read(volumeName)).toEqual({});
  });
});

describe('调度', () => {
  it('PVC 没绑上，Pod 就不调度，而且说得出原因', async () => {
    const w = await build([CLASS, claim(), pod()]);
    const running = w.cluster.registry.get(w.cluster.scheme.mustGet(PODS), 'shop', 'ledger');
    expect((running.spec as any).nodeName).toBeUndefined();
    expect((running.status as any).phase).toBe('Pending');
    expect(JSON.stringify((running.status as any).conditions))
      .toContain('unbound immediate PersistentVolumeClaims');
  });

  it('绑上之后就调度得动了', async () => {
    const w = await build([CSI_DRIVER, CLASS, claim(), pod()]);
    const running = w.cluster.registry.get(w.cluster.scheme.mustGet(PODS), 'shop', 'ledger');
    expect((running.spec as any).nodeName).toBeTruthy();
  });
});

describe('表格', () => {
  it('pvc 和 pv 的列跟 kubectl 一致，访问模式打的是缩写', async () => {
    const w = await build([CSI_DRIVER, CLASS, claim()]);
    const pvcPrinter = printerFor('persistentvolumeclaims');
    expect(pvcPrinter.columns.map((column) => column.name)).toEqual([
      'Name', 'Status', 'Volume', 'Capacity', 'Access Modes',
      'Storageclass', 'VolumeAttributesClass', 'Age',
    ]);
    const cells = pvcPrinter.cells(pvcOf(w), '3m');
    expect(cells[1]).toBe('Bound');
    expect(cells[4]).toBe('RWO');
    expect(cells[5]).toBe('standard');

    const pvCells = printerFor('persistentvolumes').cells(pvsOf(w)[0], '3m');
    expect(pvCells[3]).toBe('Delete');
    expect(pvCells[5]).toBe('shop/data');
  });

  it('默认 StorageClass 名字后面跟 (default)', async () => {
    const w = await build([CLASS]);
    const classes = w.cluster.registry.list(
      w.cluster.scheme.mustGet({ group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses' }), {}
    ).items;
    expect(printerFor('storageclasses').cells(classes[0], '1h')[0]).toBe('standard (default)');
  });
});
