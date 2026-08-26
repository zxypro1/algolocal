/**
 * External Secrets 的控制器
 *
 * 干的事很简单：按 ExternalSecret 的说明去外部密钥库取值，写成一个普通的
 * Kubernetes Secret。价值在于**密钥不再存在于集群里**（除了这份投影），
 * 也不再存在于 Git 仓库里 —— GitOps 与密钥管理的矛盾就是这么化解的。
 *
 * 两个容易被忽略的行为，这里都照真的实现：
 *  1. **`refreshInterval` 决定多久同步一次**。外部改了值，集群里不会立刻变。
 *  2. **同步出来的 Secret 归控制器管**。有人手改了它，下一次同步会盖回去。
 */
import type { KubeObject } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, SECRETS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { CLUSTERSECRETSTORES, ESO_LABEL, EXTERNALSECRETS, SECRETSTORES } from './resources';

/** 从密钥库取一个值 */
export type SecretFetcher = (input: {
  /** SecretStore 的 provider 配置 */
  store: KubeObject;
  /** ExternalSecret 所在命名空间，Kubernetes auth 要用 */
  namespace: string;
  key: string;
  property?: string;
}) => { value: string } | { error: string };

export interface ExternalSecretsOptions {
  fetch: SecretFetcher;
}

/** ESO 默认的同步间隔 */
export const DEFAULT_REFRESH_MS = 60_000;

export class ExternalSecretsController extends Controller {
  private externalSecrets: Informer;
  private stores: Informer;
  private clusterStores: Informer;
  private deployments: Informer;
  private poll: number;
  private stopped = false;

  constructor(context: ControllerContext, private readonly options: ExternalSecretsOptions) {
    super(context, 'external-secrets');
    this.externalSecrets = new Informer(this.registry, EXTERNALSECRETS);
    this.stores = this.track(new Informer(this.registry, SECRETSTORES));
    this.clusterStores = this.track(new Informer(this.registry, CLUSTERSECRETSTORES));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.externalSecrets);
    for (const informer of [this.stores, this.clusterStores, this.deployments]) {
      informer.onChange(() => this.enqueueAll());
    }
    /**
     * 定期重取。标成 background —— 它「永远有下一次」，
     * 算成前台的话世界就再也静不下来了。
     */
    this.poll = this.kernel.setInterval(() => this.enqueueAll(), DEFAULT_REFRESH_MS, {
      background: true,
      label: 'external-secrets:refresh',
    });
  }

  stop(): void {
    this.stopped = true;
    this.kernel.clearTimer(this.poll);
    super.stop();
  }

  private enqueueAll(): void {
    if (this.stopped) return;
    for (const item of this.externalSecrets.list()) this.enqueue(objectKey(item));
  }

  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[ESO_LABEL.key] !== ESO_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let external: KubeObject;
    try {
      external = this.registry.get(EXTERNALSECRETS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) { this.removeSecret(namespace, name); return; }
      throw error;
    }
    if (external.metadata.deletionTimestamp) { this.removeSecret(namespace, name); return; }

    const spec = (external.spec ?? {}) as any;
    const store = this.storeFor(spec.secretStoreRef, namespace);
    if (!store) {
      await this.fail(external, 'InvalidProviderConfig',
        `could not get SecretStore "${spec.secretStoreRef?.name}": not found`);
      return;
    }

    const data: Record<string, string> = {};
    for (const entry of spec.data ?? []) {
      const outcome = this.options.fetch({
        store,
        namespace: namespace ?? 'default',
        key: entry.remoteRef?.key ?? '',
        property: entry.remoteRef?.property,
      });
      if ('error' in outcome) {
        await this.fail(external, 'SecretSyncedError', outcome.error);
        return;
      }
      data[entry.secretKey] = outcome.value;
    }

    /**
     * dataFrom：把远端那个路径下的所有键一次性取过来。
     * 比逐个列出来省事，代价是「集群里这个 Secret 有哪些键」不再一目了然。
     */
    for (const entry of spec.dataFrom ?? []) {
      const outcome = this.options.fetch({
        store,
        namespace: namespace ?? 'default',
        key: entry.extract?.key ?? '',
      });
      if ('error' in outcome) {
        await this.fail(external, 'SecretSyncedError', outcome.error);
        return;
      }
      try {
        Object.assign(data, JSON.parse(outcome.value) as Record<string, string>);
      } catch {
        await this.fail(external, 'SecretSyncedError', 'remote value is not a key/value map');
        return;
      }
    }

    const changed = this.writeSecret(external, namespace ?? 'default', data);
    await this.succeed(external, changed);
  }

  /**
   * ExternalSecret 没了，它维护的那份投影也要走。
   *
   * 这里显式删而不是靠 ownerReference 的级联回收：集群里没有通用的
   * 垃圾回收器，各个控制器自己收拾自己建的东西（Gateway 的 Service 也一样）。
   * 不收拾的话集群里会留下一个没人认领的密钥，而且它不会再被更新 ——
   * 比没有更危险。
   */
  private removeSecret(namespace: string | undefined, name: string): void {
    if (!namespace) return;
    let secrets: KubeObject[];
    try {
      secrets = this.registry.list(SECRETS, { namespace }).items;
    } catch {
      return;
    }
    for (const secret of secrets) {
      const owned = (secret.metadata.ownerReferences ?? []).some(
        (ref) => ref.kind === 'ExternalSecret' && ref.name === name
      );
      if (!owned) continue;
      try {
        this.registry.delete(SECRETS, namespace, secret.metadata.name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  private storeFor(ref: any, namespace?: string): KubeObject | undefined {
    if (!ref?.name) return undefined;
    if (ref.kind === 'ClusterSecretStore') {
      return this.clusterStores.list().find((item) => item.metadata.name === ref.name);
    }
    return this.stores.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === ref.name
    );
  }

  /**
   * 写出目标 Secret。
   *
   * 加 ownerReference：ExternalSecret 删掉的时候这份投影跟着走，
   * 不会在集群里留下一个没人认领的密钥。
   */
  private writeSecret(external: KubeObject, namespace: string, data: Record<string, string>): boolean {
    const spec = (external.spec ?? {}) as any;
    const name = spec.target?.name ?? external.metadata.name!;
    const encoded = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, base64(value)])
    );
    const desired: KubeObject = {
      apiVersion: 'v1', kind: 'Secret',
      metadata: {
        name, namespace,
        labels: { 'reconcile.external-secrets.io/managed': 'true' },
        ownerReferences: [{
          apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret',
          name: external.metadata.name!, uid: external.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      type: spec.target?.template?.type ?? 'Opaque',
      data: encoded,
    } as KubeObject;

    let live: KubeObject | undefined;
    try {
      live = this.registry.get(SECRETS, namespace, name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!live) {
      this.registry.create(SECRETS, namespace, desired);
      return true;
    }
    // 手改过的会在这里被盖回去 —— 这份 Secret 归控制器管
    if (JSON.stringify((live as any).data ?? {}) === JSON.stringify(encoded)) return false;
    this.registry.update(SECRETS, namespace, name, { ...live, data: encoded } as KubeObject);
    return true;
  }

  /**
   * 写成功状态。
   *
   * `refreshTime` 只在这一轮真的改了东西时才更新。每轮都写的话，
   * 状态每次都不一样 -> 触发 watch -> 再 reconcile -> 再写，世界永远静不下来。
   * 真 ESO 靠的是定时器驱动，不会这样自激；我们的控制器是事件驱动的，
   * 所以「状态里不要放每次都变的值」是一条硬约束。
   */
  private async succeed(external: KubeObject, changed: boolean): Promise<void> {
    const previous = ((external.status ?? {}) as { refreshTime?: string }).refreshTime;
    await this.writeStatus(external, {
      conditions: [{
        type: 'Ready', status: 'True', reason: 'SecretSynced',
        message: 'secret synced',
        lastTransitionTime: previous && !changed ? previous : this.timestamp(),
      }],
      refreshTime: changed || !previous ? this.timestamp() : previous,
      /**
       * 记的是 generation 不是 resourceVersion。
       *
       * resourceVersion 每写一次状态就变一次，把它写进状态里等于让状态
       * 永远和上一轮不同 —— 于是 watch 一直被触发，世界静不下来。
       * generation 只在 spec 变的时候动，正是这里想表达的意思。
       */
      syncedGeneration: external.metadata.generation,
    });
  }

  private async fail(external: KubeObject, reason: string, message: string): Promise<void> {
    // 同样不能每轮都换时间戳，否则失败状态会把世界卡在自激里
    const previous = ((external.status ?? {}) as any).conditions?.[0];
    const unchanged = previous?.reason === reason && previous?.message === message;
    await this.writeStatus(external, {
      conditions: [{
        type: 'Ready', status: 'False', reason, message,
        lastTransitionTime: unchanged ? previous.lastTransitionTime : this.timestamp(),
      }],
    });
    this.context.recordEvent({
      object: external, type: 'Warning', reason, message,
    });
  }

  private timestamp(): string {
    return new Date(this.context.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private async writeStatus(external: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, EXTERNALSECRETS,
        external.metadata.namespace, external.metadata.name!, status
      );
    });
  }
}

function base64(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
