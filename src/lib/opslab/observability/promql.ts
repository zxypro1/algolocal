/**
 * PromQL 的一个子集
 *
 * 覆盖到「写得出一条真告警」为止：
 *
 *   up{job="portal"} == 0
 *   rate(http_requests_total{code=~"5.."}[5m]) > 0.05
 *   sum(rate(x[5m])) by (job) / sum(rate(y[5m])) by (job) > 0.01
 *   100 * (1 - avg(container_memory_available) / avg(container_memory_limit)) > 90
 *
 * 不做的：子查询、offset、histogram_quantile、topk 之外的排序函数、
 * 以及 range vector 直接作为结果返回（告警规则里也用不上）。
 *
 * `rate` 那一段值得单独说：它算的是**每秒**增量，而且只对 counter 有意义。
 * counter 重启会归零，真 Prometheus 会检测这种回退并补偿 —— 这里也做了，
 * 因为「Pod 重启之后 rate 冒出一个尖峰」正是不补偿的后果。
 */
import { Tsdb, matches, type Labels, type Matcher, type Sample, type Series } from './tsdb';

export interface InstantValue {
  labels: Labels;
  value: number;
}

export class PromqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromqlError';
  }
}

/** 在某个时刻求值，返回一组带标签的瞬时值 */
export function evaluate(tsdb: Tsdb, expression: string, at: number): InstantValue[] {
  const parser = new Parser(expression);
  const node = parser.parseExpression();
  parser.expectEnd();
  return new Evaluator(tsdb, at).eval(node);
}

/* ------------------------------------------------------------------ */
/* 语法树                                                              */
/* ------------------------------------------------------------------ */

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'selector'; name: string; matchers: Matcher[]; windowMs?: number }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'aggregate'; op: string; by: string[]; without: string[]; operand: Node };

const AGGREGATORS = ['sum', 'avg', 'min', 'max', 'count'];
const FUNCTIONS = ['rate', 'increase', 'abs', 'ceil', 'floor', 'clamp_max', 'clamp_min'];

class Parser {
  private index = 0;
  private readonly tokens: string[];

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  parseExpression(minPrecedence = 0): Node {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      const precedence = PRECEDENCE[op ?? ''];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', op: op!, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek() === '-') {
      this.next();
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (token === undefined) throw new PromqlError('unexpected end of input');
    if (token === '(') {
      const inner = this.parseExpression();
      this.expect(')');
      return inner;
    }
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(token)) {
      throw new PromqlError(`unexpected token ${JSON.stringify(token)}`);
    }

    if (AGGREGATORS.includes(token)) return this.parseAggregate(token);
    if (FUNCTIONS.includes(token) && this.peek() === '(') return this.parseCall(token);
    return this.parseSelector(token);
  }

  private parseAggregate(op: string): Node {
    // 分组子句可以写在括号前，也可以写在后面
    let by: string[] = [];
    let without: string[] = [];
    if (this.peek() === 'by' || this.peek() === 'without') {
      const clause = this.next()!;
      const labels = this.parseLabelList();
      if (clause === 'by') by = labels; else without = labels;
    }
    this.expect('(');
    const operand = this.parseExpression();
    this.expect(')');
    if (this.peek() === 'by' || this.peek() === 'without') {
      const clause = this.next()!;
      const labels = this.parseLabelList();
      if (clause === 'by') by = labels; else without = labels;
    }
    return { kind: 'aggregate', op, by, without, operand };
  }

  private parseLabelList(): string[] {
    this.expect('(');
    const labels: string[] = [];
    while (this.peek() !== ')') {
      const token = this.next();
      if (token === undefined) throw new PromqlError('unterminated label list');
      if (token !== ',') labels.push(token);
    }
    this.expect(')');
    return labels;
  }

  private parseCall(name: string): Node {
    this.expect('(');
    const args: Node[] = [];
    while (this.peek() !== ')') {
      args.push(this.parseExpression());
      if (this.peek() === ',') this.next();
    }
    this.expect(')');
    return { kind: 'call', name, args };
  }

  private parseSelector(name: string): Node {
    const matchers: Matcher[] = [];
    if (this.peek() === '{') {
      this.next();
      while (this.peek() !== '}') {
        const label = this.next();
        const op = this.next();
        const value = this.next();
        if (!label || !op || value === undefined) throw new PromqlError('malformed label matcher');
        if (!['=', '!=', '=~', '!~'].includes(op)) {
          throw new PromqlError(`unexpected matcher operator ${JSON.stringify(op)}`);
        }
        matchers.push({ label, op: op as Matcher['op'], value: unquote(value) });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
    }
    let windowMs: number | undefined;
    if (this.peek() === '[') {
      this.next();
      const duration = this.next();
      if (!duration) throw new PromqlError('missing range duration');
      windowMs = parseDuration(duration);
      this.expect(']');
    }
    return { kind: 'selector', name, matchers, windowMs };
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private next(): string | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) {
      throw new PromqlError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(found ?? 'end of input')}`);
    }
  }

  expectEnd(): void {
    if (this.index < this.tokens.length) {
      throw new PromqlError(`unexpected trailing input ${JSON.stringify(this.tokens[this.index])}`);
    }
  }
}

const PRECEDENCE: Record<string, number> = {
  or: 1, and: 2, unless: 2,
  '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += 1;
      tokens.push(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (['==', '!=', '>=', '<=', '=~', '!~'].includes(two)) {
      tokens.push(two);
      index += 2;
      continue;
    }
    if ('(){}[],+-*/%<>='.includes(char)) { tokens.push(char); index += 1; continue; }
    const rest = source.slice(index);
    const word = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(rest)?.[0]
      ?? /^\d+(\.\d+)?([smhdwy])?/.exec(rest)?.[0];
    if (!word) throw new PromqlError(`unexpected character ${JSON.stringify(char)}`);
    tokens.push(word);
    index += word.length;
  }
  return tokens;
}

function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhdwy])$/.exec(text);
  if (!match) throw new PromqlError(`invalid duration ${JSON.stringify(text)}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
  return Number(match[1]) * unit[match[2] as keyof typeof unit];
}

/* ------------------------------------------------------------------ */
/* 求值                                                                */
/* ------------------------------------------------------------------ */

class Evaluator {
  constructor(private readonly tsdb: Tsdb, private readonly at: number) {}

  eval(node: Node): InstantValue[] {
    switch (node.kind) {
      case 'number':
        return [{ labels: {}, value: node.value }];
      case 'selector':
        return this.selector(node);
      case 'unary': {
        return this.eval(node.operand).map((entry) => ({ ...entry, value: -entry.value }));
      }
      case 'call':
        return this.call(node);
      case 'aggregate':
        return this.aggregate(node);
      case 'binary':
        return this.binary(node);
      default:
        throw new PromqlError('unsupported expression');
    }
  }

  private selector(node: Extract<Node, { kind: 'selector' }>): InstantValue[] {
    if (node.windowMs !== undefined) {
      throw new PromqlError('range vector must be wrapped in rate() or increase()');
    }
    const out: InstantValue[] = [];
    for (const series of this.tsdb.select(node.name, node.matchers)) {
      const value = this.tsdb.valueAt(series, this.at);
      if (value !== undefined) out.push({ labels: series.labels, value });
    }
    return out;
  }

  private call(node: Extract<Node, { kind: 'call' }>): InstantValue[] {
    if (node.name === 'rate' || node.name === 'increase') {
      const target = node.args[0];
      if (target?.kind !== 'selector' || target.windowMs === undefined) {
        throw new PromqlError(`${node.name}() 的参数必须是一个带时间窗的选择器，比如 x[5m]`);
      }
      const out: InstantValue[] = [];
      for (const series of this.tsdb.select(target.name, target.matchers)) {
        const samples = this.tsdb.range(series, this.at, target.windowMs);
        const delta = counterDelta(samples);
        if (delta === undefined) continue;
        /**
         * 除的是**实际覆盖的时间**，不是窗口长度。
         *
         * 窗口里第一个点和最后一个点之间才是真的观测区间；直接除窗口长度
         * 会系统性地低估（窗口两端各差半个采集间隔）。真 Prometheus 的做法
         * 是外推到窗口边缘，采样均匀时两者的结果一致，而除观测区间这一步
         * 更容易解释，也不会在数据稀疏时凭空造出斜率。
         */
        const span = samples[samples.length - 1].at - samples[0].at;
        if (span <= 0) continue;
        const value = node.name === 'rate' ? delta / (span / 1000) : delta;
        out.push({ labels: withoutName(series), value });
      }
      return out;
    }

    const values = this.eval(node.args[0] ?? { kind: 'number', value: 0 });
    const second = node.args[1] ? this.eval(node.args[1])[0]?.value ?? 0 : 0;
    const apply = (value: number): number => {
      switch (node.name) {
        case 'abs': return Math.abs(value);
        case 'ceil': return Math.ceil(value);
        case 'floor': return Math.floor(value);
        case 'clamp_max': return Math.min(value, second);
        case 'clamp_min': return Math.max(value, second);
        default: throw new PromqlError(`unsupported function ${node.name}()`);
      }
    };
    return values.map((entry) => ({ ...entry, value: apply(entry.value) }));
  }

  private aggregate(node: Extract<Node, { kind: 'aggregate' }>): InstantValue[] {
    const values = this.eval(node.operand);
    const groups = new Map<string, InstantValue[]>();
    for (const entry of values) {
      const labels = groupLabels(entry.labels, node.by, node.without);
      const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
      groups.set(key, [...(groups.get(key) ?? []), { labels, value: entry.value }]);
    }
    const out: InstantValue[] = [];
    for (const group of groups.values()) {
      const numbers = group.map((entry) => entry.value);
      const value = ((): number => {
        switch (node.op) {
          case 'sum': return numbers.reduce((a, b) => a + b, 0);
          case 'avg': return numbers.reduce((a, b) => a + b, 0) / numbers.length;
          case 'min': return Math.min(...numbers);
          case 'max': return Math.max(...numbers);
          case 'count': return numbers.length;
          default: throw new PromqlError(`unsupported aggregator ${node.op}`);
        }
      })();
      out.push({ labels: group[0].labels, value });
    }
    return out;
  }

  /**
   * 二元运算。
   *
   * 标量参与运算时广播到每一条序列；两侧都是向量时按**标签完全相同**配对 ——
   * 配不上的那些直接消失，不报错。这是 PromQL 里最容易让人困惑的行为：
   * 一条 `a / b` 突然返回空，多半是两边的标签集不一样。
   */
  private binary(node: Extract<Node, { kind: 'binary' }>): InstantValue[] {
    const left = this.eval(node.left);
    const right = this.eval(node.right);
    const comparison = ['==', '!=', '>', '<', '>=', '<='].includes(node.op);

    const leftScalar = node.left.kind === 'number';
    const rightScalar = node.right.kind === 'number';

    if (rightScalar) {
      const scalar = right[0]?.value ?? 0;
      /**
       * 比较运算是**过滤**，不是求布尔值。
       *
       * `up == 0` 返回的是那些值确实为 0 的序列，值仍然是 0，不是 1。
       * 告警规则就是靠这个：表达式返回了序列就触发，返回空就不触发。
       */
      if (comparison) {
        return left.filter((entry) => apply(node.op, entry.value, scalar) === 1);
      }
      return left.map((entry) => ({ labels: entry.labels, value: apply(node.op, entry.value, scalar) }));
    }
    if (leftScalar) {
      const scalar = left[0]?.value ?? 0;
      return right.map((entry) => ({ labels: entry.labels, value: apply(node.op, scalar, entry.value) }));
    }

    const byKey = new Map(right.map((entry) => [labelKey(entry.labels), entry]));
    const out: InstantValue[] = [];
    for (const entry of left) {
      const other = byKey.get(labelKey(entry.labels));
      if (!other) continue;   // 配不上就没有结果
      const value = apply(node.op, entry.value, other.value);
      if (comparison && value !== 1) continue;
      out.push({ labels: entry.labels, value: comparison ? entry.value : value });
    }
    return out;
  }
}

function apply(op: string, left: number, right: number): number {
  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? NaN : left / right;
    case '%': return left % right;
    case '==': return left === right ? 1 : 0;
    case '!=': return left !== right ? 1 : 0;
    case '>': return left > right ? 1 : 0;
    case '<': return left < right ? 1 : 0;
    case '>=': return left >= right ? 1 : 0;
    case '<=': return left <= right ? 1 : 0;
    case 'and': return right !== 0 ? left : NaN;
    case 'or': return left;
    default: throw new PromqlError(`unsupported operator ${op}`);
  }
}

function labelKey(labels: Labels): string {
  return JSON.stringify(
    Object.entries(labels)
      .filter(([key]) => key !== '__name__')
      .sort(([a], [b]) => (a < b ? -1 : 1))
  );
}

function withoutName(series: Series): Labels {
  const { ...labels } = series.labels;
  return labels;
}

function groupLabels(labels: Labels, by: string[], without: string[]): Labels {
  if (by.length > 0) {
    return Object.fromEntries(by.filter((name) => labels[name] !== undefined).map((name) => [name, labels[name]]));
  }
  if (without.length > 0) {
    return Object.fromEntries(Object.entries(labels).filter(([name]) => !without.includes(name)));
  }
  return {};
}

/**
 * counter 在一个窗口里涨了多少。
 *
 * 中途归零（进程重启）要补偿，否则 rate 会算出一个负数，
 * 或者重启后的第一个窗口出现一个假的尖峰。
 */
export function counterDelta(samples: Sample[]): number | undefined {
  if (samples.length < 2) return undefined;
  let delta = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const step = samples[i].value - samples[i - 1].value;
    delta += step >= 0 ? step : samples[i].value;
  }
  return delta;
}

export { matches };
