/**
 * Argo Rollouts 的控制器
 *
 * 金丝雀的核心是一个**状态机**：`status.currentStepIndex` 指向 steps 里的
 * 第几步，每一步做完才往前挪一格。三种步骤：
 *
 *   setWeight  调整金丝雀的副本占比
 *   pause      停住（带 duration 就是等那么久，不带就是等人来 promote）
 *   analysis   起一个 AnalysisRun，按 PromQL 求值决定继续还是中止
 *
 * 中止（abort）不是「停在原地」，是**回到稳定版本**：金丝雀缩到 0，
 * 稳定版拉回满副本。这一点常被误解 —— 自动回滚是分析失败时的默认行为，
 * 不需要人介入。
 */
import type { KubeObject } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isConflict, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import {
  DEPLOYMENTS, POD_TEMPLATE_HASH, PODS, REPLICASETS, templateHash,
} from '../controllers/resources';
import { ignoreConflict, isPodReady, updateStatusIfChanged } from '../controllers/workloads';
import { ANALYSISRUNS, ANALYSISTEMPLATES, ROLLOUTS, ROLLOUTS_LABEL } from './resources';
import { parseDuration } from '../observability';

/** 分析用什么求值。由集群注入 —— 控制器自己不认识 Prometheus。 */
export type AnalysisEvaluator = (query: string) => number | undefined;

/** 查不到数最多等这么久，之后按失败算 */
export const NO_DATA_GRACE_MS = 5 * 60_000;

/**
 * 查不到数时隔多久再量一次。
 *
 * 控制器是事件驱动的，而「Prometheus 又采了一轮」不是任何一个它盯着的对象
 * 的变化。不排这个定时器的话，分析会停在 Running 上等一个永远不来的事件。
 * 比采集间隔更快地重试没有意义 —— 那边还没有新的点。
 */
const NO_DATA_RETRY_MS = 15_000;

export interface RolloutsOptions {
  evaluate: AnalysisEvaluator;
}

export class RolloutController extends Controller {
  private rollouts: Informer;
  private replicaSets: Informer;
  private pods: Informer;
  private deployments: Informer;
  private templates: Informer;
  private runs: Informer;

  /**
   * 每个 Rollout 最多挂一条唤醒定时器。
   *
   * 不去重的话每次 reconcile 都排一条：而 reconcile 是事件驱动的，
   * 一条 AnalysisRun 写回去就会再触发一轮 —— 定时器成指数增长，
   * 到点一起炸开，世界当场卡死。真控制器的 workqueue 也是这个道理，
   * 同一个 key 排队里只留一份。
   */
  private wakeups = new Map<string, number>();

  constructor(context: ControllerContext, private readonly options: RolloutsOptions) {
    super(context, 'argo-rollouts');
    this.rollouts = new Informer(this.registry, ROLLOUTS);
    this.replicaSets = this.track(new Informer(this.registry, REPLICASETS));
    this.pods = this.track(new Informer(this.registry, PODS));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.templates = this.track(new Informer(this.registry, ANALYSISTEMPLATES));
    this.runs = this.track(new Informer(this.registry, ANALYSISRUNS));
    this.watch(this.rollouts);
    for (const informer of [this.replicaSets, this.pods, this.deployments, this.runs]) {
      informer.onChange(() => {
        for (const rollout of this.rollouts.list()) this.enqueue(objectKey(rollout));
      });
    }
  }

  /** 排一条「过 ms 之后再看一眼」，同一个 Rollout 只留最新的那条 */
  private wakeAfter(rollout: KubeObject, ms: number, background: boolean): void {
    const key = `${rollout.metadata.namespace}/${rollout.metadata.name}`;
    const pending = this.wakeups.get(key);
    if (pending !== undefined) this.kernel.clearTimer(pending);
    this.wakeups.set(key, this.kernel.setTimeout(() => {
      this.wakeups.delete(key);
      this.enqueue(key);
    }, ms, { background, label: `rollout:wake:${rollout.metadata.name}` }));
  }

  stop(): void {
    for (const id of this.wakeups.values()) this.kernel.clearTimer(id);
    this.wakeups.clear();
    super.stop();
  }

  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[ROLLOUTS_LABEL.key] !== ROLLOUTS_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let rollout: KubeObject;
    try {
      rollout = this.registry.get(ROLLOUTS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (rollout.metadata.deletionTimestamp) return;

    const spec = (rollout.spec ?? {}) as any;
    const status = (rollout.status ?? {}) as any;
    const desired = spec.replicas ?? 1;
    const steps: any[] = spec.strategy?.canary?.steps ?? [];
    const hash = templateHash(spec.template);

    const owned = this.ownedReplicaSets(rollout);
    const canary = owned.find((rs) => rs.metadata.labels?.[POD_TEMPLATE_HASH] === hash)
      ?? this.createReplicaSet(rollout, hash);
    const stable = owned.find(
      (rs) => rs.metadata.labels?.[POD_TEMPLATE_HASH] === status.stableRS && rs.metadata.uid !== canary.metadata.uid
    );

    /**
     * 副本计数是**跨所有 ReplicaSet** 的总数。
     *
     * 金丝雀期间四个副本分在两个 ReplicaSet 上（比如 1 新 3 旧），
     * `kubectl get rollout` 的 CURRENT 要把两边都算上，只数一边看起来像
     * 掉了一半副本。UP-TO-DATE 才是只数新模板那一边的那一列 ——
     * 「已经换过去多少」和「一共有多少」是两个问题。
     */
    const all = owned.some((rs) => rs.metadata.uid === canary.metadata.uid) ? owned : [...owned, canary];
    const counts = () => ({
      replicas: all.reduce((sum, rs) => sum + this.podsOf(rs).length, 0),
      readyReplicas: all.reduce((sum, rs) => sum + this.readyOf(rs), 0),
      availableReplicas: all.reduce((sum, rs) => sum + this.readyOf(rs), 0),
      updatedReplicas: this.readyOf(canary),
    });

    // 第一次见到这个 Rollout：直接把它当稳定版拉满，不走金丝雀
    if (!status.stableRS) {
      this.scale(canary, desired);
      await this.writeStatus(rollout, {
        stableRS: hash, currentPodHash: hash, currentStepIndex: steps.length,
        phase: 'Healthy', ...counts(),
      });
      return;
    }

    // 模板变了：从第 0 步重新开始
    if (status.currentPodHash !== hash) {
      await this.writeStatus(rollout, {
        ...status, currentPodHash: hash, currentStepIndex: 0,
        phase: 'Progressing', abort: false, message: undefined, ...counts(),
      });
      return;
    }

    if (status.abort) {
      // 中止 = 回到稳定版，不是停在原地
      this.scale(canary, 0);
      if (stable) this.scale(stable, desired);
      await this.writeStatus(rollout, {
        ...status, phase: 'Degraded',
        message: status.message ?? 'Rollout aborted',
        ...counts(),
      });
      return;
    }

    const stepIndex: number = status.currentStepIndex ?? 0;
    if (stepIndex >= steps.length) {
      // 走完了：金丝雀转正
      this.scale(canary, desired);
      if (stable && stable.metadata.uid !== canary.metadata.uid) this.scale(stable, 0);
      await this.writeStatus(rollout, {
        ...status, stableRS: hash, phase: 'Healthy', message: undefined, ...counts(),
      });
      return;
    }

    const step = steps[stepIndex];
    const at = this.context.now();

    if (step.setWeight !== undefined) {
      const weight = Number(step.setWeight);
      const canaryReplicas = Math.max(1, Math.round((desired * weight) / 100));
      this.scale(canary, canaryReplicas);
      if (stable) this.scale(stable, Math.max(0, desired - canaryReplicas));
      // 等这一步的副本都 Ready 了才往下走
      if (this.readyOf(canary) < canaryReplicas) {
        await this.writeStatus(rollout, {
          ...status, phase: 'Progressing', canaryWeight: weight, ...counts(),
        });
        return;
      }
      await this.writeStatus(rollout, {
        ...status, phase: 'Progressing', canaryWeight: weight,
        currentStepIndex: stepIndex + 1, ...counts(),
      });
      return;
    }

    if (step.pause !== undefined) {
      /**
       * 不带 duration 的 pause 是**无限期**的，等人来 `promote`。
       * 很多人以为它会自己继续 —— 不会，这正是「手动确认」这一步的实现。
       */
      if (!step.pause?.duration) {
        await this.writeStatus(rollout, {
          ...status, phase: 'Paused', message: 'CanaryPauseStep',
          pauseStartedAt: status.pauseStartedAt ?? new Date(at).toISOString(),
          ...counts(),
        });
        return;
      }
      const startedAt = status.pauseStartedAt ? Date.parse(status.pauseStartedAt) : at;
      if (!status.pauseStartedAt) {
        await this.writeStatus(rollout, {
          ...status, phase: 'Paused', pauseStartedAt: new Date(at).toISOString(), ...counts(),
        });
        return;
      }
      const remaining = parseDuration(String(step.pause.duration)) - (at - startedAt);
      if (remaining > 0) {
        /**
         * 到点了得有人来叫醒它。
         *
         * 控制器是事件驱动的，而「暂停结束」不是任何对象的变化 ——
         * 不排这个定时器的话，Rollout 会一直停在 Paused，
         * 哪怕 duration 早就过了。
         */
        this.wakeAfter(rollout, remaining, false);
        return;
      }
      await this.writeStatus(rollout, {
        ...status, phase: 'Progressing', currentStepIndex: stepIndex + 1,
        pauseStartedAt: undefined, ...counts(),
      });
      return;
    }

    if (step.analysis) {
      const outcome = this.runAnalysis(rollout, step.analysis, stepIndex);
      if (outcome === 'Running') return;
      if (outcome === 'Failed') {
        await this.writeStatus(rollout, {
          ...status, abort: true, phase: 'Degraded',
          message: `Rollout aborted: analysis at step ${stepIndex} failed`,
          ...counts(),
        });
        return;
      }
      await this.writeStatus(rollout, { ...status, currentStepIndex: stepIndex + 1, ...counts() });
      return;
    }

    // 不认识的步骤：跳过，但留个痕迹
    this.context.recordEvent({
      object: rollout, type: 'Warning', reason: 'UnknownStep',
      message: `step ${stepIndex} has no recognised action, skipping`,
    });
    await this.writeStatus(rollout, { ...status, currentStepIndex: stepIndex + 1, ...counts() });
  }

  /**
   * 跑一次分析。
   *
   * 每个 metric 一条 PromQL，配一个 `successCondition`（形如 `result < 0.05`）。
   * 任何一条不满足就是失败，整个发布中止 —— 这就是自动回滚。
   */
  private runAnalysis(rollout: KubeObject, analysis: any, stepIndex: number): 'Successful' | 'Failed' | 'Running' {
    /**
     * 名字里必须带模板哈希。
     *
     * 只用 `<rollout>-<step>` 的话，第二次发布走到同一步时会撞上上一次留下的
     * AnalysisRun —— 那条已经是 Successful 了，于是这一次**一次都不量**就放行。
     * 坏版本就是这么溜过去的。真 Argo 的运行名同样带 podhash 和 revision。
     */
    const hash = ((rollout.status ?? {}) as { currentPodHash?: string }).currentPodHash ?? 'unknown';
    const name = `${rollout.metadata.name}-${hash}-${stepIndex}`;
    const templateName = analysis.templates?.[0]?.templateName;
    const template = this.templates.list().find(
      (item) => item.metadata.namespace === rollout.metadata.namespace && item.metadata.name === templateName
    );
    if (!template) {
      this.context.recordEvent({
        object: rollout, type: 'Warning', reason: 'AnalysisTemplateNotFound',
        message: `AnalysisTemplate "${templateName}" not found`,
      });
      return 'Failed';
    }

    const metrics: any[] = ((template.spec ?? {}) as any).metrics ?? [];

    /**
     * `initialDelay`：先别急着量。
     *
     * 金丝雀刚起来的那几秒，它的计数器还是 0、采样点还不够两个，
     * 这时候算出来的错误率是**稳定版的**错误率 —— 看着很好，
     * 然后就把坏版本放行了。真 Argo Rollouts 的 initialDelay 就是干这个的，
     * 不写它是金丝雀分析最常见的失效方式。
     */
    const existingRun = this.runs.list().find(
      (item) => item.metadata.namespace === rollout.metadata.namespace && item.metadata.name === name
    );
    const runStartedAt = ((existingRun?.status ?? {}) as any)?.startedAt;
    const startedAt = runStartedAt ?? new Date(this.context.now()).toISOString();
    const delay = metrics
      .map((metric) => (metric.initialDelay ? parseDuration(String(metric.initialDelay)) : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const waited = this.context.now() - Date.parse(startedAt);
    if (delay > 0 && waited < delay) {
      this.upsertRun(rollout, name, 'Running', metrics.map((metric) => ({
        name: metric.name, value: null, phase: 'Pending', condition: metric.successCondition,
      })), startedAt);
      this.wakeAfter(rollout, delay - waited, false);
      return 'Running';
    }

    const measurements: any[] = [];
    let phase: 'Successful' | 'Failed' | 'Running' = 'Successful';
    let missing = false;
    for (const metric of metrics) {
      const query = metric.provider?.prometheus?.query;
      const value = query ? this.options.evaluate(String(query)) : undefined;
      if (value === undefined || Number.isNaN(value)) {
        /**
         * 查不到数不等于通过。
         *
         * 金丝雀刚起来的时候指标还没攒够两个采样点，rate 算不出来 ——
         * 这时候正确的做法是**再等等**，而不是当成「没问题」放行。
         * 等太久还是没有数据，就明确判失败：一条永远查不到数的判据
         * 等于没有判据，静默放行比失败危险得多。
         */
        missing = true;
        measurements.push({ name: metric.name, value: null, phase: 'Pending', condition: metric.successCondition });
        continue;
      }
      const ok = checkCondition(metric.successCondition, value);
      measurements.push({
        name: metric.name,
        value,
        phase: ok ? 'Successful' : 'Failed',
        condition: metric.successCondition,
      });
      if (!ok) phase = 'Failed';
    }

    if (missing && phase !== 'Failed') {
      const first = Date.parse(startedAt);
      if (this.context.now() - first < NO_DATA_GRACE_MS) {
        this.upsertRun(rollout, name, 'Running', measurements, new Date(first).toISOString());
        // 后台：这条会一直重排下去，算进前台的话世界永远静不下来
        this.wakeAfter(rollout, NO_DATA_RETRY_MS, true);
        return 'Running';
      }
      this.upsertRun(rollout, name, 'Failed', measurements, new Date(first).toISOString());
      return 'Failed';
    }

    this.upsertRun(rollout, name, phase, measurements, startedAt);
    return phase as 'Successful' | 'Failed';
  }

  private upsertRun(
    rollout: KubeObject,
    name: string,
    phase: string,
    measurements: unknown[],
    startedAt = new Date(this.context.now()).toISOString()
  ): void {
    const namespace = rollout.metadata.namespace;
    const body: KubeObject = {
      apiVersion: 'argoproj.io/v1alpha1', kind: 'AnalysisRun',
      metadata: {
        name, namespace,
        ownerReferences: [{
          apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout',
          name: rollout.metadata.name!, uid: rollout.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      status: { phase, metricResults: measurements, startedAt },
    } as KubeObject;
    try {
      this.registry.get(ANALYSISRUNS, namespace, name);
      updateStatusIfChanged(this.registry, ANALYSISRUNS, namespace, name, {
        phase, metricResults: measurements, startedAt,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        this.registry.create(ANALYSISRUNS, namespace, body);
      } catch (created) {
        if (!isConflict(created)) throw created;
      }
    }
  }

  private ownedReplicaSets(rollout: KubeObject): KubeObject[] {
    return this.registry.list(REPLICASETS, { namespace: rollout.metadata.namespace }).items
      .filter((rs) => (rs.metadata.ownerReferences ?? []).some((ref) => ref.uid === rollout.metadata.uid));
  }

  private podsOf(replicaSet: KubeObject): KubeObject[] {
    return this.registry.list(PODS, { namespace: replicaSet.metadata.namespace }).items
      .filter((pod) => (pod.metadata.ownerReferences ?? []).some((ref) => ref.uid === replicaSet.metadata.uid))
      .filter((pod) => !pod.metadata.deletionTimestamp);
  }

  private readyOf(replicaSet: KubeObject): number {
    return this.podsOf(replicaSet).filter((pod) => isPodReady(pod)).length;
  }

  private scale(replicaSet: KubeObject, replicas: number): void {
    if (((replicaSet.spec as any)?.replicas ?? 0) === replicas) return;
    void ignoreConflict(() => {
      const latest = this.registry.get(REPLICASETS, replicaSet.metadata.namespace, replicaSet.metadata.name);
      this.registry.update(REPLICASETS, latest.metadata.namespace, latest.metadata.name, {
        ...latest, spec: { ...(latest.spec as any), replicas },
      });
    });
  }

  private createReplicaSet(rollout: KubeObject, hash: string): KubeObject {
    const spec = (rollout.spec ?? {}) as any;
    const template = spec.template ?? {};
    const replicaSet: KubeObject = {
      apiVersion: 'apps/v1', kind: 'ReplicaSet',
      metadata: {
        name: `${rollout.metadata.name}-${hash}`,
        namespace: rollout.metadata.namespace,
        labels: { ...(template.metadata?.labels ?? {}), [POD_TEMPLATE_HASH]: hash },
        ownerReferences: [{
          apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout',
          name: rollout.metadata.name!, uid: rollout.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      spec: {
        replicas: 0,
        selector: { matchLabels: { ...(spec.selector?.matchLabels ?? {}), [POD_TEMPLATE_HASH]: hash } },
        template: {
          ...template,
          metadata: {
            ...(template.metadata ?? {}),
            labels: { ...(template.metadata?.labels ?? {}), [POD_TEMPLATE_HASH]: hash },
          },
        },
      },
      status: {},
    } as KubeObject;
    return this.registry.create(REPLICASETS, rollout.metadata.namespace, replicaSet);
  }

  private async writeStatus(rollout: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, ROLLOUTS, rollout.metadata.namespace, rollout.metadata.name!, status
      );
    });
  }
}

/**
 * `successCondition` 的求值。
 *
 * Argo Rollouts 用的是 expr 语法，实际写出来的几乎都是
 * `result < 0.05` 这种一元比较。这里只做这一种，写别的会被当成失败 ——
 * 静默通过比明确失败危险得多。
 */
export function checkCondition(condition: string | undefined, value: number): boolean {
  if (!condition) return true;
  const match = /^\s*result\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(condition);
  if (!match) return false;
  const bound = Number(match[2]);
  switch (match[1]) {
    case '<': return value < bound;
    case '<=': return value <= bound;
    case '>': return value > bound;
    case '>=': return value >= bound;
    case '==': return value === bound;
    case '!=': return value !== bound;
    default: return false;
  }
}
