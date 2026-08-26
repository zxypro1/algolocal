/**
 * CRD 的注册
 *
 * 真集群里这件事由 apiextensions-apiserver 做，它是 kube-apiserver 的一部分，
 * 不是一个能被卸载的工作负载 —— 所以这个控制器无条件跑。
 *
 * 注册完要把 `Established` 条件写上。kubectl 在 apply 一个自定义资源之前会
 * 看 discovery，而 discovery 里有没有它取决于注册有没有完成：
 * 「CRD 和 CR 写在同一个 YAML 里，一次 apply 报 no matches for kind」
 * 就是这半秒钟的时间差。
 */
import type { KubeObject, ResourceDefinition, Scheme, TablePrinter } from '../apiserver';
import { printerFromColumns } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, splitKey,
} from '../controllers/framework';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { CUSTOMRESOURCEDEFINITIONS } from './resources';

export interface CrdOptions {
  scheme: Scheme;
  /** CRD 声明的列，交给 apiserver 打表格用 */
  printers: Map<string, TablePrinter>;
}

/** 从 CRD 里读出一条类型定义。用 storage 那个版本 —— 存进去的就是它。 */
export function definitionOf(crd: KubeObject): ResourceDefinition | undefined {
  const spec = (crd.spec ?? {}) as any;
  const versions: any[] = spec.versions ?? [];
  const version = versions.find((item) => item.storage) ?? versions.find((item) => item.served) ?? versions[0];
  if (!spec.group || !spec.names?.plural || !version?.name) return undefined;
  return {
    group: spec.group,
    version: version.name,
    resource: spec.names.plural,
    singular: spec.names.singular ?? String(spec.names.kind ?? '').toLowerCase(),
    kind: spec.names.kind,
    namespaced: (spec.scope ?? 'Namespaced') === 'Namespaced',
    shortNames: spec.names.shortNames ?? [],
    categories: spec.names.categories ?? [],
    subresources: [
      ...(version.subresources?.status ? ['status'] : []),
      ...(version.subresources?.scale ? ['scale'] : []),
    ],
  };
}

export class CrdController extends Controller {
  private crds: Informer;
  /** 注册过的类型，用来在 CRD 消失时注销 */
  private registered = new Map<string, ResourceDefinition>();

  constructor(context: ControllerContext, private readonly options: CrdOptions) {
    super(context, 'apiextensions');
    this.crds = new Informer(this.registry, CUSTOMRESOURCEDEFINITIONS);
    this.watch(this.crds);
  }

  protected async reconcile(key: string): Promise<void> {
    const { name } = splitKey(key);
    let crd: KubeObject;
    try {
      crd = this.registry.get(CUSTOMRESOURCEDEFINITIONS, undefined, name);
    } catch (error) {
      if (isNotFound(error)) return this.retire(name);
      throw error;
    }

    const definition = definitionOf(crd);
    if (!definition) {
      await ignoreConflict(() => {
        updateStatusIfChanged(this.registry, CUSTOMRESOURCEDEFINITIONS, undefined, name, {
          conditions: [{
            type: 'NamesAccepted', status: 'False', reason: 'InvalidNames',
            message: 'spec.group, spec.names.plural and a version are required',
          }],
        });
      });
      return;
    }

    this.options.scheme.register(definition);
    this.registered.set(name, definition);

    const spec = (crd.spec ?? {}) as any;
    const versions: any[] = spec.versions ?? [];
    const version = versions.find((item) => item.storage) ?? versions[0];
    const columns = version?.additionalPrinterColumns ?? [];
    if (columns.length > 0) {
      this.options.printers.set(definition.resource, printerFromColumns(columns));
    } else {
      this.options.printers.delete(definition.resource);
    }

    await ignoreConflict(() => {
      updateStatusIfChanged(this.registry, CUSTOMRESOURCEDEFINITIONS, undefined, name, {
        acceptedNames: {
          plural: definition.resource,
          singular: definition.singular,
          kind: definition.kind,
          shortNames: definition.shortNames,
          listKind: `${definition.kind}List`,
        },
        storedVersions: [definition.version],
        conditions: [
          {
            type: 'NamesAccepted', status: 'True', reason: 'NoConflicts',
            message: 'no conflicts found',
          },
          {
            type: 'Established', status: 'True', reason: 'InitialNamesAccepted',
            message: 'the initial names have been accepted',
          },
        ],
      });
    });
  }

  /**
   * CRD 没了：这个类型的对象**全部**跟着没。
   *
   * 这一步真集群里也是这样，而且没有回收站。所以 `kubectl delete crd`
   * 是那种应该先深呼吸再敲回车的命令。
   */
  private retire(name: string): void {
    const definition = this.registered.get(name);
    if (!definition) return;
    this.registered.delete(name);
    for (const object of this.registry.list(definition).items) {
      try {
        this.registry.delete(definition, object.metadata.namespace, object.metadata.name!);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    this.options.printers.delete(definition.resource);
    this.options.scheme.unregister(definition);
  }
}
