/**
 * PDB 的状态
 *
 * `kubectl get pdb` 那几列（ALLOWED DISRUPTIONS 尤其）就是这里写的。
 * 值得盯着看的是 `disruptionsAllowed`：它是 0 的时候，任何驱逐都会被拒，
 * 包括节点维护 —— 而这经常是「drain 卡住不动」的原因。
 */
import type { KubeObject } from '../apiserver';
import { Controller, ControllerContext, Informer, isNotFound, splitKey } from '../controllers/framework';
import { PODS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { evaluatePdb } from './pdb';
import { PODDISRUPTIONBUDGETS } from './resources';

export class PdbController extends Controller {
  private budgets: Informer;
  private pods: Informer;

  constructor(context: ControllerContext) {
    super(context, 'disruption');
    this.budgets = new Informer(this.registry, PODDISRUPTIONBUDGETS);
    this.pods = this.track(new Informer(this.registry, PODS));
    this.watch(this.budgets);
    // Pod 的 Ready 一变，允许中断的数量就变了
    this.pods.onChange(() => {
      for (const pdb of this.budgets.list()) {
        this.enqueue(`${pdb.metadata.namespace}/${pdb.metadata.name}`);
      }
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let pdb: KubeObject;
    try {
      pdb = this.registry.get(PODDISRUPTIONBUDGETS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const pods = this.registry.list(PODS, { namespace }).items;
    const status = evaluatePdb(pdb, pods);
    await ignoreConflict(() => {
      const latest = this.registry.get(PODDISRUPTIONBUDGETS, namespace, name);
      updateStatusIfChanged(this.registry, PODDISRUPTIONBUDGETS, namespace, name, {
        ...status,
        observedGeneration: latest.metadata.generation,
      });
    });
  }
}
