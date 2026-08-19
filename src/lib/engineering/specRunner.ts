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
  // Date 和 RegExp 没有自有可枚举属性，落到下面的通用对象分支会「两边 keys 都是空数组」
  // 从而判定相等：expect(至今为止的时间戳).toEqual(new Date(期望值)) 会永远通过，
  // 写错的实现被判成对的。
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
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
  /**
   * 按 suite 分组的钩子。存的是**数组本身**而不是当时的快照：
   * Jest 里 `describe(() => { it(...); beforeEach(setup); })` 的 setup 对前面的
   * 用例同样生效，注册时就 flat() 的话，写在测试后面的钩子会被静默丢掉。
   */
  beforeEach: Array<Array<() => unknown>>;
  afterEach: Array<Array<() => unknown>>;
  skipped: boolean;
  /** it.only：一旦出现，其余用例都跳过 */
  only?: boolean;
}

export interface SpecCollector {
  globals: Record<string, unknown>;
  cases: CollectedCase[];
  /** spec 文件求值完之后调用，把顶层的 afterAll 挂到最后一个用例上 */
  finalize(): void;
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
  const afterAllStack: Array<Array<() => unknown>> = [[]];

  /**
   * 把一组 afterAll 挂到本 suite 的最后一个用例后面。
   *
   * 之前 afterAll 是用「只跑一次的 afterEach」近似的，于是它在**第一个**用例之后
   * 就执行了 —— 一个用来检查资源泄漏的 afterAll 永远看不到后面几个用例。
   */
  function attachAfterAll(hooks: Array<() => unknown>, fromIndex: number) {
    if (!hooks.length) return;
    const last = cases[cases.length - 1];
    if (!last || cases.length === fromIndex) return;
    last.afterEach = [...last.afterEach, hooks];
  }

  function describe(name: string, fn: () => void) {
    suiteStack.push(name);
    beforeEachStack.push([]);
    afterEachStack.push([]);
    const hooks: Array<() => unknown> = [];
    afterAllStack.push(hooks);
    const startIndex = cases.length;
    try {
      fn();
    } finally {
      suiteStack.pop();
      beforeEachStack.pop();
      afterEachStack.pop();
      afterAllStack.pop();
      attachAfterAll(hooks, startIndex);
    }
  }

  function register(name: string, fn: () => unknown, options: { skipped?: boolean; only?: boolean } = {}) {
    cases.push({
      suite: [...suiteStack],
      name,
      fn,
      // 存数组引用，之后往里 push 的钩子这个用例也能拿到
      beforeEach: [...beforeEachStack],
      afterEach: [...afterEachStack],
      skipped: Boolean(options.skipped),
      only: options.only,
    });
  }

  const it = (name: string, fn: () => unknown) => register(name, fn);
  (it as any).skip = (name: string, fn: () => unknown) => register(name, fn, { skipped: true });
  (it as any).only = (name: string, fn: () => unknown) => register(name, fn, { only: true });

  return {
    cases,
    finalize: () => {
      attachAfterAll(afterAllStack[0], 0);
      // it.only 出现过就只跑它们，其余标成跳过 —— 以前 only 被实现成普通注册，
      // 写了 only 反而整个文件都跑，和作者的意图正相反
      if (cases.some((testCase) => testCase.only)) {
        for (const testCase of cases) {
          if (!testCase.only) testCase.skipped = true;
        }
      }
    },
    globals: {
      describe,
      it,
      test: it,
      expect,
      beforeEach: (fn: () => unknown) => beforeEachStack[beforeEachStack.length - 1].push(fn),
      afterEach: (fn: () => unknown) => afterEachStack[afterEachStack.length - 1].push(fn),
      /**
       * beforeAll 用「只跑一次的 beforeEach」实现：它确实只在本 suite 第一个用例前跑一次。
       *
       * 但注意 lab 是每个用例重建的（时钟和指标都要归零），所以 beforeAll 里建立的
       * **lab 状态**只对第一个用例有效。要跨用例共享的东西请放在模块作用域里，
       * 或者干脆用 beforeEach。
       */
      beforeAll: (fn: () => unknown) => {
        let done = false;
        beforeEachStack[beforeEachStack.length - 1].push(async () => {
          if (done) return;
          done = true;
          await fn();
        });
      },
      afterAll: (fn: () => unknown) => afterAllStack[afterAllStack.length - 1].push(fn),
    },
  };
}
