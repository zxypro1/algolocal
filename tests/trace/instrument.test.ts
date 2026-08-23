/**
 * 插桩的回归测试
 *
 * 重点在两件事：
 * 1. 插桩后的代码必须还是**同一个程序** —— 返回值、异常、副作用都不能变；
 * 2. 生成的代码不能引用当前作用域里不存在的名字，否则 ReferenceError。
 *    这一条踩过：循环变量被记在函数作用域里，循环结束后的语句还去读它。
 */
import * as ts from 'typescript';
import { instrumentSource } from '../../src/lib/trace/instrument';
import { createTraceRecorder } from '../../src/lib/trace/recorder';
import { TRACE_LIMITS } from '../../src/lib/trace/types';

function runTraced(source: string, args: unknown[] = []) {
  const instrumented = instrumentSource(ts, source);
  const recorder = createTraceRecorder();
  const fn = new Function(
    '__trace',
    'args',
    `var userExports = null;
     (function(){ var module = { exports: null }; ${instrumented} userExports = module.exports; })();
     return userExports.apply(null, args);`
  );
  const result = fn(recorder.api, args);
  return { result, trace: recorder.trace, instrumented };
}

describe('instrumented code behaves like the original', () => {
  it('keeps the return value of a plain function', () => {
    const { result, trace } = runTraced(
      `function twoSum(nums, target) {
         const seen = new Map();
         for (let i = 0; i < nums.length; i++) {
           const need = target - nums[i];
           if (seen.has(need)) return [seen.get(need), i];
           seen.set(nums[i], i);
         }
         return [];
       }
       module.exports = twoSum;`,
      [[2, 7, 11, 15], 9]
    );
    expect(result).toEqual([0, 1]);
    expect(trace.steps.length).toBeGreaterThan(0);
  });

  it('does not reference loop variables after the loop ends', () => {
    // 这里正是那个 bug：for 之后的语句一度会带上 i / need，直接 ReferenceError
    const { result, instrumented } = runTraced(
      `function f(xs) {
         let total = 0;
         for (let i = 0; i < xs.length; i++) {
           const doubled = xs[i] * 2;
           total += doubled;
         }
         return total;
       }
       module.exports = f;`,
      [[1, 2, 3]]
    );
    expect(result).toBe(12);
    // 最后一条 step 属于 return 那一行，不该出现循环内的名字
    const lastStep = instrumented.slice(instrumented.lastIndexOf('__trace.step'));
    expect(lastStep).not.toContain('"doubled"');
    expect(lastStep).not.toContain('"i"');
  });

  it('handles closures without dragging in outer scopes', () => {
    const { result } = runTraced(
      `function makeCounter() {
         let count = 0;
         return function tick() { count += 1; return count; };
       }
       function run() {
         const tick = makeCounter();
         tick(); tick();
         return tick();
       }
       module.exports = run;`
    );
    expect(result).toBe(3);
  });

  it('handles an arrow function with a concise body', () => {
    const { result, trace } = runTraced(
      `const double = (x) => x * 2;
       function run(n) { return double(n) + double(n); }
       module.exports = run;`,
      [5]
    );
    expect(result).toBe(20);
    // 简写体被展开成块，所以箭头函数里那一步也被记录了
    expect(trace.steps.some((step) => step.fn === 'double')).toBe(true);
  });

  it('handles destructuring in params and declarations', () => {
    const { result } = runTraced(
      `function run({ a, b }, [c, d]) {
         const { x, y } = { x: a + c, y: b + d };
         return x * y;
       }
       module.exports = run;`,
      [{ a: 1, b: 2 }, [3, 4]]
    );
    expect(result).toBe(24);
  });

  it('survives async/await and preserves the resolved value', async () => {
    const { result } = runTraced(
      `async function run(n) {
         const first = await Promise.resolve(n);
         const second = await Promise.resolve(first * 2);
         return second + 1;
       }
       module.exports = run;`,
      [10]
    );
    await expect(result as Promise<number>).resolves.toBe(21);
  });

  it('survives generators', () => {
    const { result } = runTraced(
      `function* gen(n) {
         for (let i = 0; i < n; i++) yield i * i;
       }
       function run(n) {
         let total = 0;
         for (const v of gen(n)) total += v;
         return total;
       }
       module.exports = run;`,
      [4]
    );
    expect(result).toBe(0 + 1 + 4 + 9);
  });

  it('records recursion depth on the call stack', () => {
    const { result, trace } = runTraced(
      `function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
       module.exports = fact;`,
      [4]
    );
    expect(result).toBe(24);
    const maxDepth = Math.max(...trace.steps.map((step) => step.depth));
    expect(maxDepth).toBeGreaterThanOrEqual(4);
  });

  it('pops the call stack even when the function throws', () => {
    const source = `function boom() { throw new Error('nope'); }
       function run() {
         try { boom(); } catch (e) { return 'caught'; }
       }
       module.exports = run;`;
    const { result, trace } = runTraced(source);
    expect(result).toBe('caught');
    // exit 在 finally 里，抛异常也会执行，所以栈深度回得来
    const depths = trace.steps.map((step) => step.depth);
    expect(depths[depths.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('trace bounds', () => {
  it('stops recording past the cap but lets the program finish', () => {
    const { result, trace } = runTraced(
      `function run() {
         let total = 0;
         for (let i = 0; i < 20000; i++) total += i;
         return total;
       }
       module.exports = run;`
    );
    // 程序照常跑完，拿到正确结果
    expect(result).toBe((19999 * 20000) / 2);
    // 但轨迹被截断了，没有把内存吃光
    expect(trace.steps.length).toBe(TRACE_LIMITS.maxSteps);
    expect(trace.truncated).toBe(true);
    expect(trace.droppedSteps).toBeGreaterThan(0);
  });

  it('instruments bodies that have no braces', () => {
    // 不补大括号的话，这个循环体永远不会被插桩：
    // 两万次迭代只能录到 4 步，轨迹等于没有
    const { result, trace } = runTraced(
      `function run() {
         let total = 0;
         for (let i = 0; i < 5; i++) total += i;
         if (total > 0) total = total * 2;
         return total;
       }
       module.exports = run;`
    );
    expect(result).toBe(20);
    // 循环体每一轮都记一步
    const loopSteps = trace.steps.filter((step) => step.vars.some((v) => v.name === 'i'));
    expect(loopSteps.length).toBe(5);
  });

  it('snapshots values instead of holding references', () => {
    const { trace } = runTraced(
      `function run() {
         const acc = [];
         acc.push(1);
         acc.push(2);
         return acc;
       }
       module.exports = run;`
    );
    const accStates = trace.steps
      .map((step) => step.vars.find((v) => v.name === 'acc')?.value)
      .filter(Boolean);
    // 存引用的话每一步都会显示最终的 [1, 2]
    expect(accStates).toContain('[]');
    expect(accStates.some((value) => value === '[1]')).toBe(true);
  });
});
