/**
 * Envoy Gateway 控制器
 *
 * 它是**跑在集群里的一个工作负载**，不是宿主特判出来的东西：reconcile 之前
 * 先确认自己那个 Deployment 还在、还可用。学员把它卸载掉，Gateway 就不再被
 * program —— 第 8 关最后一步「旧控制器彻底下线」之所以能判定，靠的就是这条。
 *
 * 它干的事和真 Envoy Gateway 一样：
 *  1. 认领 controllerName 指向自己的 GatewayClass；
 *  2. 给每个 Gateway 建一个 LoadBalancer Service（真的会在
 *     envoy-gateway-system 里建出来，名字是 `envoy-<ns>-<name>`）；
 *  3. 把 Service 拿到的地址写回 Gateway 的 status.addresses；
 *  4. 校验 HTTPRoute 的 parentRefs 与 backendRefs，写 status.parents 里的
 *     Accepted / ResolvedRefs 条件。
 *
 * 第 4 步是排查的关键：路由不生效时，`kubectl describe httproute` 里的
 * ResolvedRefs=False 会直接说出是后端 Service 不存在还是端口对不上。
 */
import { Priority } from '../kernel';
import type { KubeObject, ResourceDefinition } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isConflict, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, SERVICES } from '../controllers/resources';
import { GATEWAYCLASSES, GATEWAYS, HTTPROUTES, ENVOYPROXIES } from './resources';

export const ENVOY_CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';
/** 控制器自己那个 Deployment 靠这个标签认出来 */
export const ENVOY_LABEL = { key: 'app.kubernetes.io/name', value: 'envoy-gateway' };

export interface GatewayControllerOptions {
  /** 认哪个 controllerName。默认就是 Envoy Gateway 的那个。 */
  controllerName?: string;
}

export class GatewayController extends Controller {
  private gateways: Informer;
  private routes: Informer;
  private classes: Informer;
  private deployments: Informer;
  private services: Informer;
  private readonly controllerName: string;

  constructor(context: ControllerContext, options: GatewayControllerOptions = {}) {
    super(context, 'envoy-gateway');
    this.controllerName = options.controllerName ?? ENVOY_CONTROLLER;

    this.gateways = new Informer(this.registry, GATEWAYS);
    this.routes = this.track(new Informer(this.registry, HTTPROUTES));
    this.classes = this.track(new Informer(this.registry, GATEWAYCLASSES));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.services = this.track(new Informer(this.registry, SERVICES));

    this.watch(this.gateways);
    // 路由、class、自己的部署、后端 Service 变了，相关的 Gateway 都要重看
    for (const informer of [this.routes, this.classes, this.deployments, this.services]) {
      informer.onChange(() => {
        for (const gateway of this.gateways.list()) this.queue.add(objectKey(gateway));
      });
    }
  }

  /**
   * 控制器自己在不在。
   *
   * 这是「组件是工作负载」这条约束的兑现处：没有可用的 Deployment，
   * 什么都不做，Gateway 会一直停在 Programmed=Unknown。
   */
  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[ENVOY_LABEL.key] !== ENVOY_LABEL.value) return false;
      const status = (deployment.status ?? {}) as { availableReplicas?: number };
      return (status.availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let gateway: KubeObject;
    try {
      gateway = this.registry.get(GATEWAYS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) { this.removeService(namespace, name); return; }
      throw error;
    }
    if (gateway.metadata.deletionTimestamp) { this.removeService(namespace, name); return; }

    const spec = (gateway.spec ?? {}) as any;
    const owned = this.classes.list().find(
      (item) => item.metadata.name === spec.gatewayClassName
        && ((item.spec ?? {}) as any).controllerName === this.controllerName
    );
    if (!owned) return;   // 别人的 class，不插手

    if (!this.installed()) {
      this.setGatewayStatus(gateway, {
        accepted: 'Unknown', programmed: 'Unknown',
        message: 'Waiting for controller',
        addresses: [],
      });
      return;
    }

    // 给这个 Gateway 建（或更新）它的数据面：一个 Deployment + 一个 LoadBalancer Service
    this.ensureDeployment(gateway);
    const service = this.ensureService(gateway, owned);
    const address = ((service?.status ?? {}) as any)?.loadBalancer?.ingress?.[0]?.ip;

    this.setGatewayStatus(gateway, {
      accepted: 'True',
      programmed: address ? 'True' : 'Unknown',
      message: address ? 'Sending translated configuration to Envoy' : 'Waiting for address',
      addresses: address ? [{ type: 'IPAddress', value: address }] : [],
      listeners: listenersOf(spec).map((listener) => ({
        name: listener.name,
        supportedKinds: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute' }],
        attachedRoutes: this.routesFor(gateway, listener).length,
        conditions: [
          condition('Accepted', 'True', 'Accepted', 'Sending translated configuration to Envoy', this.context.now()),
          condition('Programmed', address ? 'True' : 'Unknown', 'Programmed', 'Listener is ready', this.context.now()),
          condition('ResolvedRefs', 'True', 'ResolvedRefs', 'Listener references resolved', this.context.now()),
        ],
      })),
    });

    for (const route of this.routesFor(gateway)) this.setRouteStatus(route, gateway);
  }

  /**
   * Gateway 没了，它的 Service 也要跟着走。
   *
   * 不清的话地址还挂在那儿，`resolveGateway` 会一直返回 503，
   * 看起来像「入口坏了」而不是「入口被删了」。
   */
  private removeService(namespace: string | undefined, name: string): void {
    const proxy = `envoy-${namespace}-${name}`;
    for (const definition of [SERVICES, DEPLOYMENTS]) {
      try {
        this.registry.delete(definition, 'envoy-gateway-system', proxy);
      } catch (error) {
        if (!isNotFound(error) && !isConflict(error)) throw error;
      }
    }
  }

  /**
   * Gateway 的数据面。
   *
   * 真 Envoy Gateway 给每个 Gateway 起一组 envoy 进程，这里同样做成一个
   * Deployment —— 不是为了好看：过了 Gateway 之后那段流量的源头是这些 Pod，
   * NetworkPolicy 看到的就是它们。没有这一层，「只允许 Gateway 访问后端」
   * 这条策略在这个世界里根本写不出来。
   */
  private ensureDeployment(gateway: KubeObject): void {
    const namespace = 'envoy-gateway-system';
    const name = `envoy-${gateway.metadata.namespace}-${gateway.metadata.name}`;
    const labels = {
      'app.kubernetes.io/name': 'envoy',
      'app.kubernetes.io/component': 'proxy',
      'gateway.envoyproxy.io/owning-gateway-name': gateway.metadata.name!,
      'gateway.envoyproxy.io/owning-gateway-namespace': gateway.metadata.namespace ?? '',
    };
    const image = this.proxyImage();
    const desired = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: {
        name, namespace, labels,
        ownerReferences: [{
          apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
          name: gateway.metadata.name, uid: gateway.metadata.uid, controller: true,
        }],
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: {
          'app.kubernetes.io/name': 'envoy',
          'gateway.envoyproxy.io/owning-gateway-name': gateway.metadata.name,
        } },
        template: {
          metadata: { labels },
          spec: { containers: [{
            name: 'envoy', image,
            ports: listenersOf((gateway.spec ?? {}) as any).map((listener) => ({ containerPort: listener.port })),
          }] },
        },
      },
    } as unknown as KubeObject;

    const existing = this.deployments.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === name
    );
    try {
      if (!existing) { this.registry.create(DEPLOYMENTS, namespace, desired); return; }
      const merged = { ...existing, spec: { ...(existing.spec as any), ...(desired.spec as any) } };
      if (JSON.stringify(merged.spec) === JSON.stringify(existing.spec)) return;
      this.registry.update(DEPLOYMENTS, namespace, name, merged);
    } catch (error) {
      if (!isConflict(error) && !isNotFound(error)) throw error;
    }
  }

  /** 数据面用哪个镜像：跟控制器自己用同一个，和真 Envoy Gateway 一样 */
  private proxyImage(): string {
    const controller = this.deployments.list().find(
      (deployment) => deployment.metadata.labels?.[ENVOY_LABEL.key] === ENVOY_LABEL.value
    );
    const containers = ((controller?.spec ?? {}) as any)?.template?.spec?.containers ?? [];
    return containers[0]?.image ?? 'registry.k8s.io/gateway-api/envoy-gateway:latest';
  }

  /** 每个 Gateway 对应一个 LoadBalancer Service，真 Envoy Gateway 也是这么干的 */
  private ensureService(gateway: KubeObject, gatewayClass: KubeObject): KubeObject | undefined {
    const namespace = 'envoy-gateway-system';
    const name = `envoy-${gateway.metadata.namespace}-${gateway.metadata.name}`;
    const parameters = this.parametersOf(gatewayClass);
    const listeners = listenersOf((gateway.spec ?? {}) as any);

    const desired = {
      apiVersion: 'v1', kind: 'Service',
      metadata: {
        name, namespace,
        labels: {
          'gateway.envoyproxy.io/owning-gateway-name': gateway.metadata.name,
          'gateway.envoyproxy.io/owning-gateway-namespace': gateway.metadata.namespace ?? '',
        },
        annotations: parameters.annotations,
        // 属主关系写清楚，`kubectl get svc -o yaml` 里看得出这个 Service 是谁生的
        ownerReferences: [{
          apiVersion: 'gateway.networking.k8s.io/v1',
          kind: 'Gateway',
          name: gateway.metadata.name,
          uid: gateway.metadata.uid,
          controller: true,
        }],
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerClass: parameters.loadBalancerClass,
        selector: { 'app.kubernetes.io/name': 'envoy', 'gateway.envoyproxy.io/owning-gateway-name': gateway.metadata.name },
        ports: listeners.map((listener) => ({
          name: listener.name,
          port: listener.port,
          targetPort: listener.port,
          protocol: 'TCP',
        })),
      },
    } as unknown as KubeObject;

    const existing = this.services.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === name
    );
    try {
      if (!existing) return this.registry.create(SERVICES, namespace, desired);
      const merged = { ...existing, spec: { ...(existing.spec as any), ...(desired.spec as any) } };
      if (JSON.stringify(merged.spec) === JSON.stringify(existing.spec)) return existing;
      return this.registry.update(SERVICES, namespace, name, merged);
    } catch (error) {
      if (isConflict(error) || isNotFound(error)) return existing;
      throw error;
    }
  }

  /** GatewayClass -> EnvoyProxy -> LoadBalancer Service 长什么样 */
  private parametersOf(gatewayClass: KubeObject): {
    loadBalancerClass?: string;
    annotations?: Record<string, string>;
  } {
    const ref = ((gatewayClass.spec ?? {}) as any).parametersRef;
    if (!ref?.name) return {};
    try {
      const proxy = this.registry.get(ENVOYPROXIES, ref.namespace ?? 'envoy-gateway-system', ref.name);
      const service = ((proxy.spec ?? {}) as any)?.provider?.kubernetes?.envoyService ?? {};
      return { loadBalancerClass: service.loadBalancerClass, annotations: service.annotations };
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  /** 挂在这个 Gateway 上的 HTTPRoute */
  private routesFor(gateway: KubeObject, listener?: { name: string }): KubeObject[] {
    return this.routes.list().filter((route) => {
      const parents = ((route.spec ?? {}) as any).parentRefs ?? [];
      return parents.some((parent: any) =>
        parent.name === gateway.metadata.name
        && (parent.namespace ?? route.metadata.namespace) === gateway.metadata.namespace
        && (!listener || !parent.sectionName || parent.sectionName === listener.name)
      );
    });
  }

  /**
   * HTTPRoute 的状态。
   *
   * `ResolvedRefs=False` 是排查路由不生效时最有用的一条：它会直接说出
   * 后端 Service 不存在，而不是让人去猜。
   */
  private setRouteStatus(route: KubeObject, gateway: KubeObject): void {
    const backends = ((route.spec ?? {}) as any).rules?.flatMap((rule: any) => rule.backendRefs ?? []) ?? [];
    const missing = backends.filter((backend: any) => {
      const namespace = backend.namespace ?? route.metadata.namespace;
      return !this.services.list().some(
        (item) => item.metadata.namespace === namespace && item.metadata.name === backend.name
      );
    });

    const now = this.context.now();
    const parents = [{
      parentRef: {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: gateway.metadata.name,
        namespace: gateway.metadata.namespace,
      },
      controllerName: this.controllerName,
      conditions: [
        condition('Accepted', 'True', 'Accepted', 'Route is accepted', now),
        missing.length === 0
          ? condition('ResolvedRefs', 'True', 'ResolvedRefs', 'Resolved all the Object references for the Route', now)
          : condition(
            'ResolvedRefs', 'False', 'BackendNotFound',
            `Service ${route.metadata.namespace}/${missing[0].name} not found`,
            now
          ),
      ],
    }];
    this.writeStatus(HTTPROUTES, route, { parents });
  }

  private setGatewayStatus(
    gateway: KubeObject,
    input: {
      accepted: string;
      programmed: string;
      message: string;
      addresses: Array<{ type: string; value: string }>;
      listeners?: unknown[];
    }
  ): void {
    const now = this.context.now();
    this.writeStatus(GATEWAYS, gateway, {
      addresses: input.addresses,
      conditions: [
        condition('Accepted', input.accepted, 'Accepted', 'The Gateway has been scheduled by Envoy Gateway', now),
        condition('Programmed', input.programmed, 'Programmed', input.message, now),
      ],
      listeners: input.listeners ?? [],
    });
  }

  private writeStatus(definition: ResourceDefinition, object: KubeObject, status: unknown): void {
    if (JSON.stringify(object.status ?? null) === JSON.stringify(status)) return;
    try {
      const latest = this.registry.get(definition, object.metadata.namespace, object.metadata.name);
      if (JSON.stringify(latest.status ?? null) === JSON.stringify(status)) return;
      this.registry.updateStatus(definition, object.metadata.namespace, object.metadata.name, {
        ...latest, status,
      });
    } catch (error) {
      if (!isConflict(error) && !isNotFound(error)) throw error;
    }
  }
}

/**
 * 给 LoadBalancer Service 分地址。
 *
 * 相当于云厂商的 controller，或者内网里那台 MetalLB。地址从哪个池子里出，
 * 由 `spec.loadBalancerClass` 决定 —— 内网入口和公网入口的分野就在这里，
 * 而不是在 Gateway 自己身上。
 */
export interface AddressPool {
  /** `corp.internal/office-lb` */
  loadBalancerClass: string;
  /** 从哪个网段分 */
  cidrPrefix: string;
  /** 这个池子里的地址，谁能访问到 */
  zones: Array<'office' | 'internet'>;
}

export class LoadBalancerController extends Controller {
  private services: Informer;
  private assigned = new Map<string, string>();

  constructor(context: ControllerContext, private readonly pools: AddressPool[]) {
    super(context, 'load-balancer');
    this.services = new Informer(this.registry, SERVICES);
    this.watch(this.services, (service, key) =>
      ((service.spec as any)?.type === 'LoadBalancer' ? key : null));
  }

  /** 从池子里挑一个还没被占的地址 */
  private pick(pool: AddressPool, key: string): string {
    const taken = new Set(this.assigned.values());
    const start = hash(key) % 200;
    for (let offset = 0; offset < 200; offset += 1) {
      const candidate = `${pool.cidrPrefix}.${((start + offset) % 200) + 20}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`地址池 ${pool.loadBalancerClass} 用完了`);
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let service: KubeObject;
    try {
      service = this.registry.get(SERVICES, namespace, name);
    } catch (error) {
      if (isNotFound(error)) { this.assigned.delete(key); return; }
      throw error;
    }
    const spec = (service.spec ?? {}) as any;
    if (spec.type !== 'LoadBalancer' || service.metadata.deletionTimestamp) return;

    const pool = this.pools.find((item) => item.loadBalancerClass === spec.loadBalancerClass)
      ?? this.pools[0];
    if (!pool) return;

    /**
     * 地址按 key 派生，不用计数器 —— 同一个世界重放两次要分到同一个地址。
     *
     * 但派生会撞：两个 Service 抢到同一个地址的话，路由会串到别人身上。
     * 撞了就往后顺延，顺延也是确定的。
     */
    const address = this.assigned.get(key) ?? this.pick(pool, key);
    this.assigned.set(key, address);

    const status = { loadBalancer: { ingress: [{ ip: address }] } };
    if (JSON.stringify(service.status ?? null) === JSON.stringify(status)) return;
    this.kernel.setTimeout(() => {
      try {
        const latest = this.registry.get(SERVICES, namespace, name);
        if (JSON.stringify(latest.status ?? null) === JSON.stringify(status)) return;
        this.registry.updateStatus(SERVICES, namespace, name, { ...latest, status });
      } catch (error) {
        if (!isConflict(error) && !isNotFound(error)) throw error;
      }
    }, 300, { priority: Priority.CONTROLLER, label: `load-balancer:${key}` });
  }
}

/* ------------------------------------------------------------------ */

function listenersOf(spec: any): Array<{ name: string; port: number; protocol: string; hostname?: string }> {
  return (spec.listeners ?? []).map((listener: any) => ({
    name: listener.name,
    port: Number(listener.port),
    protocol: listener.protocol ?? 'HTTP',
    hostname: listener.hostname,
  }));
}

function condition(type: string, status: string, reason: string, message: string, now: number) {
  return {
    type, status, reason, message,
    observedGeneration: 1,
    lastTransitionTime: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result >>> 0;
}
