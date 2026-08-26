/**
 * 备份与恢复
 *
 * 这一组要钉住的是一句很扎心的话：**备份显示 Completed，不等于数据在里面。**
 *
 * 少打一个标签（让 Velero 认得的 VolumeSnapshotClass），备份照样绿，
 * 恢复出来是一个一模一样的空盘。真 Velero 就是这个行为，所以这里也是。
 */
import { createExecHandler, createOpsWorld } from '../../src/lib/opslab/lab';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const APP_IMAGE = 'registry.corp.internal/ledger:3.2';
const CSI_IMAGE = 'registry.k8s.io/sig-storage/csi-provisioner:v5.1.0';
const SNAP_IMAGE = 'registry.k8s.io/sig-storage/snapshot-controller:v8.2.0';
const VELERO_IMAGE = 'velero/velero:v1.16.1';

const PVCS = { group: '', version: 'v1', resource: 'persistentvolumeclaims' } as const;
const PODS = { group: '', version: 'v1', resource: 'pods' } as const;
const BACKUPS = { group: 'velero.io', version: 'v1', resource: 'backups' } as const;
const RESTORES = { group: 'velero.io', version: 'v1', resource: 'restores' } as const;
const CONFIGMAPS = { group: '', version: 'v1', resource: 'configmaps' } as const;

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

const VELERO = {
  ...deployment('velero', VELERO_IMAGE),
  metadata: {
    name: 'velero', namespace: 'velero', labels: { 'app.kubernetes.io/name': 'velero' },
  },
};

const LOCATION = {
  apiVersion: 'velero.io/v1', kind: 'BackupStorageLocation',
  metadata: { name: 'default', namespace: 'velero' },
  spec: {
    provider: 'aws', default: true,
    objectStorage: { bucket: 'corp-backups' },
    config: { region: 'internal', s3Url: 'http://minio.storage.svc:9000' },
  },
};

const STORAGE_CLASS = {
  apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
  metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
  provisioner: 'csi.corp.internal', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate',
};

const snapshotClass = (labelled: boolean) => ({
  apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass',
  metadata: {
    name: 'csi-standard',
    ...(labelled ? { labels: { 'velero.io/csi-volumesnapshot-class': 'true' } } : {}),
  },
  driver: 'csi.corp.internal', deletionPolicy: 'Delete',
});

const CLAIM = {
  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
  metadata: { name: 'data', namespace: 'payments' },
  spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '5Gi' } } },
};

const DEPLOY = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'ledger', namespace: 'payments' },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'ledger' } },
    template: {
      metadata: { labels: { app: 'ledger' } },
      spec: {
        containers: [{ name: 'app', image: APP_IMAGE, volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data' } }],
      },
    },
  },
};

const SERVICE = {
  apiVersion: 'v1', kind: 'Service',
  metadata: { name: 'ledger', namespace: 'payments' },
  spec: { selector: { app: 'ledger' }, ports: [{ port: 5432, targetPort: 5432 }] },
};

const CONFIG = {
  apiVersion: 'v1', kind: 'ConfigMap',
  metadata: { name: 'ledger-config', namespace: 'payments' },
  data: { 'rates.json': '{"usd":1}' },
};

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    namespaces: ['default', 'payments', 'kube-system', 'velero'],
    images: {
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [CSI_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [SNAP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [VELERO_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

async function build(labelled: boolean) {
  const world = await createOpsWorld({
    world: spec([
      deployment('csi-driver', CSI_IMAGE),
      deployment('snapshot-controller', SNAP_IMAGE),
      VELERO, LOCATION, STORAGE_CLASS, snapshotClass(labelled),
      CLAIM, DEPLOY, SERVICE, CONFIG,
    ]),
  });
  await world.cluster.advanceBy(90_000);
  // 写一笔数据进去
  const pods = world.cluster.registry.list(
    world.cluster.scheme.mustGet(PODS), { namespace: 'payments' }
  ).items;
  await createExecHandler(world.cluster)(
    {
      namespace: 'payments', pod: pods[0].metadata.name!,
      command: ['sh', '-c', 'echo balance=42 > /data/ledger.txt'], stdin: false, tty: false,
    },
    ''
  );
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const create = (w: World, definition: any, namespace: string | undefined, object: unknown) =>
  w.cluster.registry.create(w.cluster.scheme.mustGet(definition), namespace, object as KubeObject);

const backupOf = (w: World, name: string) =>
  (w.cluster.registry.get(w.cluster.scheme.mustGet(BACKUPS), 'velero', name).status ?? {}) as any;
const restoreOf = (w: World, name: string) =>
  (w.cluster.registry.get(w.cluster.scheme.mustGet(RESTORES), 'velero', name).status ?? {}) as any;

const makeBackup = async (w: World, name = 'daily', overrides: Record<string, unknown> = {}) => {
  create(w, BACKUPS, 'velero', {
    apiVersion: 'velero.io/v1', kind: 'Backup',
    metadata: { name, namespace: 'velero' },
    spec: { includedNamespaces: ['payments'], storageLocation: 'default', ...overrides },
  });
  await w.cluster.advanceBy(60_000);
};

/** 把命名空间连同里面的东西一起抹掉 —— 模拟误删 */
function wipe(w: World, namespace: string) {
  for (const definition of w.cluster.scheme.list()) {
    if (!definition.namespaced) continue;
    for (const object of w.cluster.registry.list(definition, { namespace }).items) {
      try {
        w.cluster.registry.delete(definition, namespace, object.metadata.name!);
      } catch {
        // 已经被属主带走了
      }
    }
  }
}

describe('备份', () => {
  it('位置可用、快照类打了标签：对象和数据都在备份里', async () => {
    const w = await build(true);
    await makeBackup(w);

    const status = backupOf(w, 'daily');
    expect(status.phase).toBe('Completed');
    expect(status.warnings).toBe(0);
    expect(status.volumeSnapshotsAttempted).toBe(1);
    expect(status.volumeSnapshotsCompleted).toBe(1);

    const stored = w.cluster.backups.get('daily')!;
    expect(stored.items.some((item) => item.kind === 'ConfigMap' && item.metadata.name === 'ledger-config')).toBe(true);
    expect(Object.keys(stored.snapshots)).toEqual(['payments/data']);
  });

  /**
   * 少打一个标签，备份**照样绿**。
   * 这就是「我们有备份」和「我们能恢复」之间那道最贵的缝。
   */
  it('快照类没打 velero 标签：备份还是 Completed，只是数据不在里面', async () => {
    const w = await build(false);
    await makeBackup(w);

    const status = backupOf(w, 'daily');
    expect(status.phase).toBe('Completed');
    expect(status.volumeSnapshotsAttempted).toBe(1);
    expect(status.volumeSnapshotsCompleted).toBe(0);
    expect(status.warnings).toBe(1);
    expect(w.cluster.backups.get('daily')!.snapshots).toEqual({});
  });

  it('位置不可用：备份直接失败，而且说得出是哪个位置', async () => {
    const w = await build(true);
    create(w, BACKUPS, 'velero', {
      apiVersion: 'velero.io/v1', kind: 'Backup',
      metadata: { name: 'oops', namespace: 'velero' },
      spec: { includedNamespaces: ['payments'], storageLocation: 'offsite' },
    });
    await w.cluster.advanceBy(30_000);

    const status = backupOf(w, 'oops');
    expect(status.phase).toBe('Failed');
    expect(status.failureReason).toContain('"offsite" is unavailable');
  });

  it('snapshotVolumes: false 是明确只要对象图', async () => {
    const w = await build(true);
    await makeBackup(w, 'meta-only', { snapshotVolumes: false });
    expect(backupOf(w, 'meta-only').volumeSnapshotsAttempted).toBe(0);
    expect(w.cluster.backups.get('meta-only')!.snapshots).toEqual({});
  });

  it('Velero 没跑：Backup 对象建得出来，永远停在 New', async () => {
    const w = await build(true);
    w.cluster.registry.delete(
      w.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'velero', 'velero'
    );
    await w.cluster.advanceBy(30_000);
    await makeBackup(w, 'nobody-home');
    expect(backupOf(w, 'nobody-home')).toEqual({});
  });

  it('事件不进备份，打了 exclude 标签的也不进', async () => {
    const w = await build(true);
    create(w, CONFIGMAPS, 'payments', {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: {
        name: 'scratch', namespace: 'payments',
        labels: { 'velero.io/exclude-from-backup': 'true' },
      },
      data: { a: 'b' },
    });
    await makeBackup(w);
    const stored = w.cluster.backups.get('daily')!;
    expect(stored.items.some((item) => item.kind === 'Event')).toBe(false);
    expect(stored.items.some((item) => item.metadata.name === 'scratch')).toBe(false);
  });
});

describe('恢复', () => {
  async function backedUp(labelled: boolean) {
    const w = await build(labelled);
    await makeBackup(w);
    wipe(w, 'payments');
    await w.cluster.advanceBy(30_000);
    return w;
  }

  const restoreInto = async (w: World, overrides: Record<string, unknown> = {}) => {
    create(w, RESTORES, 'velero', {
      apiVersion: 'velero.io/v1', kind: 'Restore',
      metadata: { name: 'rescue', namespace: 'velero' },
      spec: { backupName: 'daily', ...overrides },
    });
    await w.cluster.advanceBy(120_000);
  };

  it('连数据一起回来了', async () => {
    const w = await backedUp(true);
    expect(w.cluster.registry.list(w.cluster.scheme.mustGet(PVCS), { namespace: 'payments' }).items)
      .toHaveLength(0);

    await restoreInto(w);
    expect(restoreOf(w, 'rescue').phase).toBe('Completed');

    const claim = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'payments', 'data');
    expect((claim.status as any).phase).toBe('Bound');
    expect(w.cluster.volumes.read((claim.spec as any).volumeName))
      .toEqual({ 'ledger.txt': 'balance=42\n' });

    // Deployment 回来了，Pod 由控制器自己重建
    const pods = w.cluster.registry.list(w.cluster.scheme.mustGet(PODS), { namespace: 'payments' }).items;
    expect(pods.length).toBeGreaterThan(0);
    const read = await createExecHandler(w.cluster)(
      { namespace: 'payments', pod: pods[0].metadata.name!, command: ['cat', '/data/ledger.txt'], stdin: false, tty: false },
      ''
    );
    expect(read.stdout).toBe('balance=42\n');
  });

  /**
   * 没有卷快照的备份，恢复出来的是一块**空盘**。
   * PVC 是 Bound、Pod 是 Running、`kubectl get` 全绿 —— 只有数据没了。
   */
  it('备份里没有卷数据：恢复出来是一块空盘', async () => {
    const w = await backedUp(false);
    await restoreInto(w);

    const claim = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'payments', 'data');
    expect((claim.status as any).phase).toBe('Bound');
    expect(w.cluster.volumes.read((claim.spec as any).volumeName)).toEqual({});
  });

  it('恢复到另一个命名空间：演练不动生产', async () => {
    const w = await build(true);
    await makeBackup(w);
    await restoreInto(w, { namespaceMapping: { payments: 'payments-drill' } });

    const claim = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'payments-drill', 'data');
    expect(w.cluster.volumes.read((claim.spec as any).volumeName))
      .toEqual({ 'ledger.txt': 'balance=42\n' });
    // 生产那份原封不动
    const original = w.cluster.registry.get(w.cluster.scheme.mustGet(PVCS), 'payments', 'data');
    expect((original.spec as any).volumeName).not.toBe((claim.spec as any).volumeName);
  });

  /**
   * 对象还在的时候恢复，Velero 默认**跳过**。
   * 「恢复跑完了，phase 是 PartiallyFailed，但什么都没变」就是这么来的。
   */
  it('对象已经在了就跳过，并且记进 warnings', async () => {
    const w = await build(true);
    await makeBackup(w);
    await restoreInto(w);
    expect(restoreOf(w, 'rescue').phase).toBe('PartiallyFailed');
    expect(restoreOf(w, 'rescue').warnings).toBeGreaterThan(0);
  });

  /**
   * clusterIP 是集群分配的，不是用户写的。
   * 原样带回去就是两个 Service 抢同一个地址。
   */
  it('恢复出来的 Service 重新分地址，不抢原来那个', async () => {
    const w = await build(true);
    const services = { group: '', version: 'v1', resource: 'services' } as const;
    const before = (w.cluster.registry.get(
      w.cluster.scheme.mustGet(services), 'payments', 'ledger'
    ).spec as any).clusterIP;
    expect(before).toBeTruthy();

    await makeBackup(w);
    await restoreInto(w, { namespaceMapping: { payments: 'payments-drill' } });

    const after = (w.cluster.registry.get(
      w.cluster.scheme.mustGet(services), 'payments-drill', 'ledger'
    ).spec as any).clusterIP;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('备份不存在：恢复直接失败', async () => {
    const w = await build(true);
    await restoreInto(w, { backupName: 'nope' });
    expect(restoreOf(w, 'rescue').phase).toBe('Failed');
    expect(restoreOf(w, 'rescue').failureReason).toContain('not found');
  });
});
