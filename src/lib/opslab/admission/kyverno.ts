/**
 * Kyverno
 *
 * 和 PSA 的分工：PSA 是三档写死的预置标准，靠命名空间标签开关；Kyverno 是
 * 自定义规则，写在 `ClusterPolicy` 里。前者管「别做危险的事」，后者管
 * 「按我们公司的规矩来」—— 必须有 owner 标签、镜像只能来自内网仓库、
 * 镜像必须签过名。
 *
 * 它是集群里的一个工作负载：Deployment 停了，所有策略立刻失效，
 * 而 `kubectl get cpol` 照样看得见。和 CNI、网格是同一条约束。
 *
 * 做进来的三种 validate：
 *  - `pattern`：Kyverno 自己那套结构匹配，支持 `*`、`?*`、`!` 前缀与 `|` 或
 *  - `cel`：CEL 表达式（用 @marcbachmann/cel-js 真求值）
 *  - `deny.conditions`：按 CEL 求值，命中就拒绝
 * 外加 `verifyImages`：镜像签名验证。
 */
import { evaluate } from '@marcbachmann/cel-js';
import type { KubeObject, ResourceDefinition } from '../apiserver';

export interface KyvernoContext {
  /** 策略清单 */
  policies(): KubeObject[];
  /** 控制面在不在 */
  installed(): boolean;
  /** 这个镜像有没有被某把公钥签过 */
  verifyImage(image: string, publicKey: string): boolean;
}

export interface KyvernoOutcome {
  /** 拦下来的原因 */
  denied?: string;
  /** 不拦但要提醒（policy 的 validationFailureAction 是 Audit 时） */
  warnings: string[];
}

export function reviewWithKyverno(
  context: KyvernoContext,
  input: { definition: ResourceDefinition; object: KubeObject; namespace?: string }
): KyvernoOutcome {
  const warnings: string[] = [];
  if (!context.installed()) return { warnings };

  for (const policy of context.policies()) {
    const spec = (policy.spec ?? {}) as any;
    const audit = (spec.validationFailureAction ?? 'Enforce') === 'Audit';
    for (const rule of spec.rules ?? []) {
      if (!ruleMatches(rule, input)) continue;
      const failure = evaluateRule(context, rule, input);
      if (!failure) continue;
      const message = `policy ${policy.metadata.name}/${rule.name} `
        + `for resource ${input.namespace ?? ''}/${input.object.metadata?.name}: '${failure}'`;
      if (audit) warnings.push(message);
      else return { denied: message, warnings };
    }
  }
  return { warnings };
}

/* ------------------------------------------------------------------ */
/* match                                                               */
/* ------------------------------------------------------------------ */

function ruleMatches(
  rule: any,
  input: { definition: ResourceDefinition; object: KubeObject; namespace?: string }
): boolean {
  const any = rule.match?.any as any[] | undefined;
  const all = rule.match?.all as any[] | undefined;
  const filters = any ?? all ?? (rule.match?.resources ? [{ resources: rule.match.resources }] : []);
  if (filters.length === 0) return false;
  const matched = all
    ? filters.every((entry) => filterMatches(entry.resources ?? {}, input))
    : filters.some((entry) => filterMatches(entry.resources ?? {}, input));
  if (!matched) return false;

  // exclude 命中就整条不适用
  const excludes = (rule.exclude?.any as any[] | undefined) ?? [];
  return !excludes.some((entry) => filterMatches(entry.resources ?? {}, input));
}

function filterMatches(
  resources: any,
  input: { definition: ResourceDefinition; object: KubeObject; namespace?: string }
): boolean {
  const kinds: string[] = resources.kinds ?? [];
  if (kinds.length > 0) {
    const wanted = [input.definition.kind, `${input.definition.group}/${input.definition.version}/${input.definition.kind}`];
    if (!kinds.some((kind) => wanted.includes(kind) || kind === '*')) return false;
  }
  const namespaces: string[] = resources.namespaces ?? [];
  if (namespaces.length > 0) {
    if (!input.namespace) return false;
    if (!namespaces.some((entry) => globMatch(entry, input.namespace!))) return false;
  }
  const selector = resources.selector?.matchLabels as Record<string, string> | undefined;
  if (selector) {
    const labels = input.object.metadata?.labels ?? {};
    if (!Object.entries(selector).every(([key, value]) => labels[key] === value)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

function evaluateRule(
  context: KyvernoContext,
  rule: any,
  input: { object: KubeObject; namespace?: string }
): string | undefined {
  if (rule.verifyImages) {
    return verifyImages(context, rule.verifyImages, input.object);
  }

  const validate = rule.validate;
  if (!validate) return undefined;
  const message = validate.message ?? 'validation error';

  if (validate.pattern) {
    return matchesPattern(input.object, validate.pattern) ? undefined : message;
  }
  if (validate.cel?.expressions) {
    for (const expression of validate.cel.expressions) {
      if (!celTruthy(expression.expression, input.object)) {
        return expression.message ?? message;
      }
    }
    return undefined;
  }
  if (validate.deny?.conditions?.all) {
    const all = validate.deny.conditions.all as any[];
    const hit = all.every((condition) => conditionHolds(condition, input.object));
    return hit ? message : undefined;
  }
  return undefined;
}

function celTruthy(expression: string, object: KubeObject): boolean {
  try {
    return evaluate(expression, { object, request: { object } }) === true;
  } catch {
    // 表达式写错了当作不通过 —— 静默放行比拦错更糟
    return false;
  }
}

function conditionHolds(condition: any, object: KubeObject): boolean {
  if (typeof condition.key === 'string' && condition.key.startsWith('{{')) {
    // Kyverno 的 JMESPath 变量。这里只支持它包着的 CEL 形式。
    return celTruthy(condition.key.replace(/^\{\{|\}\}$/g, '').trim(), object);
  }
  return celTruthy(String(condition.key ?? 'false'), object);
}

/* ------------------------------------------------------------------ */
/* verifyImages                                                        */
/* ------------------------------------------------------------------ */

function verifyImages(context: KyvernoContext, entries: any[], object: KubeObject): string | undefined {
  const containers: any[] = [
    ...((object.spec as any)?.containers ?? []),
    ...((object.spec as any)?.template?.spec?.containers ?? []),
  ];
  for (const entry of entries) {
    const globs: string[] = entry.imageReferences ?? ['*'];
    const key = entry.attestors?.[0]?.entries?.[0]?.keys?.publicKeys;
    if (!key) continue;
    for (const container of containers) {
      const image = String(container.image ?? '');
      if (!globs.some((glob) => globMatch(glob, image))) continue;
      if (!context.verifyImage(image, key)) {
        return `image ${image} is not signed by the expected key`;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* pattern                                                             */
/* ------------------------------------------------------------------ */

/**
 * Kyverno 的结构匹配。
 *
 * 规则里只写关心的字段，其余不管。几个约定：
 *  - `*` 表示「这个字段得有值」，`?*` 也是；
 *  - `!x` 表示「不能等于 x」；
 *  - `a | b` 表示「等于其中之一」；
 *  - 数组里写一项，表示**每一项都要满足**它。
 */
export function matchesPattern(value: unknown, pattern: unknown): boolean {
  if (pattern === null || pattern === undefined) return true;

  if (Array.isArray(pattern)) {
    if (!Array.isArray(value)) return false;
    return value.every((item) => pattern.some((entry) => matchesPattern(item, entry)));
  }

  if (typeof pattern === 'object') {
    if (typeof value !== 'object' || value === null) return false;
    return Object.entries(pattern as Record<string, unknown>).every(([key, child]) => {
      const optional = key.endsWith('?');
      const name = optional ? key.slice(0, -1) : key;
      const actual = (value as Record<string, unknown>)[name];
      if (actual === undefined) return optional;
      return matchesPattern(actual, child);
    });
  }

  const text = String(pattern);
  if (text.includes('|')) {
    return text.split('|').some((entry) => matchesPattern(value, entry.trim()));
  }
  if (text.startsWith('!')) return !matchesPattern(value, text.slice(1));
  if (text === '*' || text === '?*') return value !== undefined && value !== null && value !== '';
  return globMatch(text, String(value));
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}
