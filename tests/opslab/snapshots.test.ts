/**
 * CSI 卷快照
 *
 * 要钉住的四件：
 *   1. 快照控制器是**另一个**工作负载，装了 CSI 驱动不等于装了它
 *   2. 快照是时间点，拍完再写的东西不在里面
 *   3. 从快照恢复出来的盘带着那一刻的字节
 *   4. deletionPolicy 决定 VolumeSnapshot 没了之后字节还在不在
 */
import { createExecHandler, createOpsWorld } from '../../src/lib/opslab/lab';
import { printerFor } from '../../src/lib/opslab/apiserver';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const APP_IMAGE = 'registry.corp.internal/ledger:3.2';
const CSI_IMAGE = 'registry.k8s.io/sig-storage/csi-provisioner:v5.1.0';
const SNAP_IMAGE = 'registry.k8s.io/sig-storage/snapshot-controller:v8.2.0';

const PVCS = { group: '', version: 'v1', resource: 'persistentvolumeclaims' } as const;
const PODS = { group: '', version: 'v1', resource: 'pods' } as const;
const SNAPSHOTS = { group: 'snapshot.storage.k8s.io', version: 'v1', resource: 'volumesnapshots' } as const;
const CONTENTS = { group: 'snapshot.storage.k8s.io', version: 'v1', resource: 'volumesnapshotcontents' } as const;

const deployment = (name: string, image: string) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name, namespace: 'kube-system', labels: { 'app.kubernetes.io/name': name } },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': name } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': name } },
      spec: { containers: [{ name: 'main', image }] },
    },
  },
});

const CSI_DRIVER = deployment('csi-driver', CSI_IMAGE);
const SNAP_CONTROLLER = deployment('snapshot-controller', SNAP_IMAGE);

const CLASS = {
  apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
  metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
  provisioner: 'csi.corp.internal', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
};

const SNAP_CLASS = {
  apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass',
  metadata: { name: 'csi-standard' },
  driver: 'csi.corp.internal', deletionPolicy: 'Delete',
};

const CLAIM = {
  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
  metadata: { name: 'data', namespace: 'shop' },
  spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '5Gi' } } },
};

const POD = {
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name: 'ledger', namespace: 'shop' },
  spec: {
    containers: [{ name: 'app', image: APP_IMAGE, volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data' } }],
  },
};

const snapshot = (name: string, overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
  metadata: { name, namespace: 'shop' },
  spec: {
    volumeSnapshotClassName: 'csi-standard',
    source: { persistentVolumeClaimName: 'data' },
    ...overrides,
  },
});

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    namespaces: ['default', 'shop', 'kube-system'],
    images: {
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [CSI_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [SNAP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
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

async function writeData(w: World, text: string) {
  return createExecHandler(w.cluster)(
    { namespace: 'shop', pod: 'ledger', command: ['sh', '-c', `echo ${text} > /data/ledger.txt`], stdin: false, tty: false },
    ''
  );
}

const snapOf = (w: World, name: string) =>
  w.cluster.registry.get(w.cluster.scheme.mustGet(SNAPSHOTS), 'shop', name);
const contentsOf = (w: World) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(CONTENTS), {}).items;
const create = (w: World, definition: any, namespace: string | undefined, object: unknown) =>
  w.cluster.registry.create(w.cluster.scheme.mustGet(definition), namespace, object as KubeObject);

const PLATFORM = [CSI_DRIVER, SNAP_CONTROLLER, CLASS, SNAP_CLASS];

describe('拍快照', () => {
  it('拍下来的是那一刻的字节，之后再写跟它无关', async () => {
    const w = await build([...PLATFORM, CLAIM, POD]);
    await writeData(w, 'before');

    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);

    await writeData(w, 'after');

    const status = (snapOf(w, 'snap-1').status ?? {}) as any;
    expect(status.readyToUse).toBe(true);
    expect(status.boundVolumeSnapshotContentName).toMatch(/^snapcontent-/);
    expect(status.restoreSize).toBe('5Gi');
    expect(w.cluster.volumes.read(status.boundVolumeSnapshotContentName))
      .toEqual({ 'ledger.txt': 'before\n' });
  });

  /**
   * 快照控制器和 CSI 驱动是两个工作负载。
   * 只装驱动的话，VolumeSnapshot 建得出来，然后就没有然后了 ——
   * 没有 content、没有事件、status 是空的。这个「安静的失败」要能复现。
   */
  it('没有 snapshot-controller：对象建得出来，但永远不就绪', async () => {
    const w = await build([CSI_DRIVER, CLASS, SNAP_CLASS, CLAIM, POD]);
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(120_000);

    expect((snapOf(w, 'snap-1').status ?? {})).toEqual({});
    expect(contentsOf(w)).toHaveLength(0);
  });

  it('快照类名写错：失败信息落在 status.error 上', async () => {
    const w = await build([...PLATFORM, CLAIM, POD]);
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1', { volumeSnapshotClassName: 'nope' }));
    await w.cluster.advanceBy(30_000);

    const status = (snapOf(w, 'snap-1').status ?? {}) as any;
    expect(status.readyToUse).toBe(false);
    expect(status.error.message).toContain('"nope" not found');
  });

  it('源 PVC 没绑上就拍不了', async () => {
    const w = await build([SNAP_CONTROLLER, CLASS, SNAP_CLASS, CLAIM]);
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);

    const status = (snapOf(w, 'snap-1').status ?? {}) as any;
    expect(status.error.message).toContain('is not bound');
  });
});

describe('从快照恢复', () => {
  async function snapped() {
    const w = await build([...PLATFORM, CLAIM, POD]);
    await writeData(w, 'before');
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);
    return w;
  }

  it('dataSource 指到快照上，供给出来的盘带着数据', async () => {
    const w = await snapped();
    create(w, PVCS, 'shop', {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: 'restored', namespace: 'shop' },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
        dataSource: { apiGroup: 'snapshot.storage.k8s.io', kind: 'VolumeSnapshot', name: 'snap-1' },
      },
    });
    await w.cluster.advanceBy(30_000);

    const restored = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'shop', 'restored');
    expect((restored.status as any).phase).toBe('Bound');
    expect(w.cluster.volumes.read((restored.spec as any).volumeName))
      .toEqual({ 'ledger.txt': 'before\n' });

    // 挂上去真读得到
    create(w, PODS, 'shop', {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'check', namespace: 'shop' },
      spec: {
        containers: [{ name: 'app', image: APP_IMAGE, volumeMounts: [{ name: 'd', mountPath: '/data' }] }],
        volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'restored' } }],
      },
    });
    await w.cluster.advanceBy(60_000);
    const read = await createExecHandler(w.cluster)(
      { namespace: 'shop', pod: 'check', command: ['cat', '/data/ledger.txt'], stdin: false, tty: false },
      ''
    );
    expect(read.stdout).toBe('before\n');
  });

  it('快照还没就绪就先不供给，而不是给一块空盘', async () => {
    // 没有 snapshot-controller：快照永远不就绪
    const w = await build([CSI_DRIVER, CLASS, SNAP_CLASS, CLAIM, POD]);
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);
    create(w, PVCS, 'shop', {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: 'restored', namespace: 'shop' },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
        dataSource: { apiGroup: 'snapshot.storage.k8s.io', kind: 'VolumeSnapshot', name: 'snap-1' },
      },
    });
    await w.cluster.advanceBy(60_000);

    const restored = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'shop', 'restored');
    expect((restored.status as any).phase).toBe('Pending');
    expect((restored.spec as any).volumeName).toBeUndefined();
  });
});

describe('快照的生命周期', () => {
  it('deletionPolicy Delete：VolumeSnapshot 没了，字节也没了', async () => {
    const w = await build([...PLATFORM, CLAIM, POD]);
    await writeData(w, 'before');
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);
    const contentName = (snapOf(w, 'snap-1').status as any).boundVolumeSnapshotContentName;

    w.cluster.registry.delete(w.cluster.scheme.mustGet(SNAPSHOTS), 'shop', 'snap-1');
    await w.cluster.advanceBy(30_000);

    expect(contentsOf(w)).toHaveLength(0);
    expect(w.cluster.volumes.read(contentName)).toEqual({});
  });

  /**
   * Retain 留下的是一张**没有主人**的快照：
   * `kubectl get volumesnapshot` 里看不见它，`volumesnapshotcontent` 里还在，
   * 存储账单上也还在。
   */
  it('deletionPolicy Retain：content 留下来，只是没人认领了', async () => {
    const keep = { ...SNAP_CLASS, metadata: { name: 'keep' }, deletionPolicy: 'Retain' };
    const w = await build([CSI_DRIVER, SNAP_CONTROLLER, CLASS, keep, CLAIM, POD]);
    await writeData(w, 'before');
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1', { volumeSnapshotClassName: 'keep' }));
    await w.cluster.advanceBy(30_000);
    const contentName = (snapOf(w, 'snap-1').status as any).boundVolumeSnapshotContentName;

    w.cluster.registry.delete(w.cluster.scheme.mustGet(SNAPSHOTS), 'shop', 'snap-1');
    await w.cluster.advanceBy(30_000);

    expect(contentsOf(w)).toHaveLength(1);
    expect(w.cluster.volumes.read(contentName)).toEqual({ 'ledger.txt': 'before\n' });
  });
});

describe('表格', () => {
  it('volumesnapshot 的列跟 kubectl 一致', async () => {
    const w = await build([...PLATFORM, CLAIM, POD]);
    create(w, SNAPSHOTS, 'shop', snapshot('snap-1'));
    await w.cluster.advanceBy(30_000);

    const printer = printerFor('volumesnapshots');
    expect(printer.columns.map((column) => column.name)).toEqual([
      'Name', 'Readytouse', 'Sourcepvc', 'Sourcesnapshotcontent', 'Restoresize',
      'Snapshotclass', 'Snapshotcontent', 'Creationtime', 'Age',
    ]);
    const cells = printer.cells(snapOf(w, 'snap-1'), '30s');
    expect(cells[1]).toBe('true');
    expect(cells[2]).toBe('data');
    expect(cells[5]).toBe('csi-standard');
  });
});
