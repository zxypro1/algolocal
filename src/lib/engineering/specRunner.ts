/**
 * 极简的 describe / it / expect 测试框架
 *
 * 工程题的验收用例是「隐藏的 spec 文件」，需要一个能在浏览器里运行、
 * 支持 async、能报告每个用例耗时与失败详情的小框架。这里不追求 Jest 的
 * 完整能力，只覆盖工程验收会用到的断言。
 */

export class AssertionError extends Error {
  expected?: string;
  actual?: string;

  constructor(message: string, expected?: string, actual?: string) {
    super(message);
    this.name = 'AssertionError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function formatValue(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => formatValue(item, depth + 1));
    if (value.length > 20) items.push(`…${value.length - 20} more`);
    return `[${items.join(', ')}]`;
  }
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  try {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return `{ ${entries.map(([key, item]) => `${key}: ${formatValue(item, depth + 1)}`).join(', ')} }`;
  } catch {
    return String(value);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of Array.from(a.entries())) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    return Array.from(a).every((item) => b.has(item));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual((a as any)[key], (b as any)[key])
    );
  }
  return false;
}

interface MatcherContext {
  actual: unknown;
  negated: boolean;
}

function assert(context: MatcherContext, passed: boolean, message: string, expected?: string) {
  const ok = context.negated ? !passed : passed;
  if (ok) return;
  throw new AssertionError(
    context.negated ? message.replace('to ', 'not to ') : message,
    expected,
    formatValue(context.actual)
  );
}

function buildMatchers(actual: unknown, negated: boolean): Record<string, any> {
  const context: MatcherContext = { actual, negated };

  const matchers: Record<string, any> = {
    toBe(expected: unknown) {
      assert(
        context,
        Object.is(actual, expected),
        `expected ${formatValue(actual)} to be ${formatValue(expected)}`,
        formatValue(expected)
      );
    },
    toEqual(expected: unknown) {
      assert(
        context,
        deepEqual(actual, expected),
        `expected ${formatValue(actual)} to equal ${formatValue(expected)}`,
        formatValue(expected)
      );
    },
    toBeTruthy() {
      assert(context, Boolean(actual), `expected ${formatValue(actual)} to be truthy`, 'truthy');
    },
    toBeFalsy() {
      assert(context, !actual, `expected ${formatValue(actual)} to be falsy`, 'falsy');
    },
    toBeNull() {
      assert(context, actual === null, `expected ${formatValue(actual)} to be null`, 'null');
    },
    toBeUndefined() {
      assert(context, actual === undefined, `expected ${formatValue(actual)} to be undefined`, 'undefined');
    },
    toBeDefined() {
      assert(context, actual !== undefined, `expected value to be defined`, 'defined');
    },
    toBeInstanceOf(expected: any) {
      assert(
        context,
        actual instanceof expected,
        `expected ${formatValue(actual)} to be an instance of ${expected?.name || String(expected)}`,
        expected?.name
      );
    },
    toBeGreaterThan(expected: number) {
      assert(context, (actual as number) > expected, `expected ${formatValue(actual)} to be > ${expected}`, `> ${expected}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      assert(context, (actual as number) >= expected, `expected ${formatValue(actual)} to be >= ${expected}`, `>= ${expected}`);
    },
    toBeLessThan(expected: number) {
      assert(context, (actual as number) < expected, `expected ${formatValue(actual)} to be < ${expected}`, `< ${expected}`);
    },
    toBeLessThanOrEqual(expected: number) {
      assert(context, (actual as number) <= expected, `expected ${formatValue(actual)} to be <= ${expected}`, `<= ${expected}`);
    },
    toBeCloseTo(expected: number, precision = 2) {
      const tolerance = Math.pow(10, -precision) / 2;
      assert(
        context,
        Math.abs((actual as number) - expected) < tolerance,
        `expected ${formatValue(actual)} to be close to ${expected}`,
        `≈ ${expected}`
      );
    },
    toContain(expected: unknown) {
      const passed = Array.isArray(actual)
        ? actual.some((item) => deepEqual(item, expected))
        : typeof actual === 'string'
        ? actual.includes(String(expected))
        : actual instanceof Set
        ? actual.has(expected)
        : false;
      assert(context, passed, `expected ${formatValue(actual)} to contain ${formatValue(expected)}`, formatValue(expected));
    },
    toHaveLength(expected: number) {
      const length = (actual as { length?: number })?.length;
      assert(context, length === expected, `expected length ${length} to be ${expected}`, String(expected));
    },
    toHaveProperty(path: string, expected?: unknown) {
      const segments = path.split('.');
      let current: any = actual;
      let exists = true;
      for (const segment of segments) {
        if (current == null || !(segment in current)) {
          exists = false;
          break;
        }
        current = current[segment];
      }
      const passed = exists && (arguments.length < 2 || deepEqual(current, expected));
      assert(context, passed, `expected object to have property "${path}"`, path);
    },
    toMatch(pattern: RegExp | string) {
      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      assert(context, regex.test(String(actual)), `expected ${formatValue(actual)} to match ${regex}`, String(regex));
    },
    toThrow(expected?: string | RegExp) {
      if (typeof actual !== 'function') {
        throw new AssertionError('expect(fn).toThrow() requires a function');
      }
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matched =
        didThrow &&
        (expected === undefined ||
          (typeof expected === 'string' ? message.includes(expected) : expected.test(message)));
      assert(context, matched, `expected function to throw${expected ? ` ${expected}` : ''}`, String(expected ?? 'an error'));
    },
  };

  matchers.rejects = {
    async toThrow(expected?: string | RegExp) {
      const promise = typeof actual === 'function' ? (actual as () => Promise<unknown>)() : actual;
      let thrown: unknown;
      let didThrow = false;
      try {
        await promise;
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matched =
        didThrow &&
        (expected === undefined ||
          (typeof expected === 'string' ? message.includes(expected) : expected.test(message)));
      assert(context, matched, `expected promise to reject${expected ? ` with ${expected}` : ''}`, String(expected ?? 'a rejection'));
    },
  };

  matchers.resolves = {
    async toEqual(expected: unknown) {
      const value = await (typeof actual === 'function' ? (actual as () => unknown)() : actual);
      assert(
        { actual: value, negated },
        deepEqual(value, expected),
        `expected resolved value ${formatValue(value)} to equal ${formatValue(expected)}`,
        formatValue(expected)
      );
    },
  };

  if (!negated) {
    matchers.not = buildMatchers(actual, true);
  }

  return matchers;
}

export function expect(actual: unknown): Record<string, any> {
  return buildMatchers(actual, false);
}

export interface CollectedCase {
  suite: string[];
  name: string;
  fn: () => unknown;
  beforeEach: Array<() => unknown>;
  afterEach: Array<() => unknown>;
  skipped: boolean;
}

export interface SpecCollector {
  globals: Record<string, unknown>;
  cases: CollectedCase[];
}

/**
 * 创建一次收集上下文。spec 文件在被 require 时同步注册用例，
 * 之后由 runner 逐个异步执行。
 */
export function createSpecCollector(): SpecCollector {
  const cases: CollectedCase[] = [];
  const suiteStack: string[] = [];
  const beforeEachStack: Array<Array<() => unknown>> = [[]];
  const afterEachStack: Array<Array<() => unknown>> = [[]];

  function describe(name: string, fn: () => void) {
    suiteStack.push(name);
    beforeEachStack.push([]);
    afterEachStack.push([]);
    try {
      fn();
    } finally {
      suiteStack.pop();
      beforeEachStack.pop();
      afterEachStack.pop();
    }
  }

  function register(name: string, fn: () => unknown, skipped = false) {
    cases.push({
      suite: [...suiteStack],
      name,
      fn,
      beforeEach: beforeEachStack.flat(),
      afterEach: afterEachStack.flat(),
      skipped,
    });
  }

  const it = (name: string, fn: () => unknown) => register(name, fn);
  (it as any).skip = (name: string, fn: () => unknown) => register(name, fn, true);
  (it as any).only = (name: string, fn: () => unknown) => register(name, fn);

  return {
    cases,
    globals: {
      describe,
      it,
      test: it,
      expect,
      beforeEach: (fn: () => unknown) => beforeEachStack[beforeEachStack.length - 1].push(fn),
      afterEach: (fn: () => unknown) => afterEachStack[afterEachStack.length - 1].push(fn),
      // beforeAll/afterAll 用「只跑一次」的 beforeEach 近似实现
      beforeAll: (fn: () => unknown) => {
        let done = false;
        beforeEachStack[beforeEachStack.length - 1].push(async () => {
          if (done) return;
          done = true;
          await fn();
        });
      },
      afterAll: (fn: () => unknown) => {
        let done = false;
        afterEachStack[afterEachStack.length - 1].push(async () => {
          if (done) return;
          done = true;
          await fn();
        });
      },
    },
  };
}
