/**
 * 题库里每一份参考实现，都要真的通过它自己的测试用例
 *
 * 这个文件取代了原来四个打 /api/run 的测试。那个接口在执行搬进浏览器时就删了，
 * 它们从此一直是红的 —— 而且顺带把「参考实现到底对不对」这个最值得测的
 * 不变量一起带走了。
 *
 * 现在用的是执行器本身导出的函数：同一套参数解析、同一套 new Function 执行、
 * 同一套结果比较。测试里另写一份的话，题库和线上执行器分歧了也测不出来。
 *
 * 只覆盖 JavaScript：Python 要 Pyodide（浏览器），Java/C++/C 这个应用根本
 * 不执行，它们的模板只是给人看的。
 */
import fs from 'fs';
import path from 'path';
import {
  deepEqual,
  executeJavaScript,
  parseTestInput,
} from '../../src/hooks/useWasmExecutor';

interface TestCase {
  input: string;
  output: string;
}

interface Problem {
  id: string;
  title: { en: string; zh: string };
  tags?: string[];
  template?: Record<string, string>;
  solution?: Record<string, string>;
  tests: TestCase[];
}

const problems: Problem[] = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'public', 'problems.json'), 'utf8')
);

/**
 * 参考实现和自己的用例对不上的题目。
 *
 * 两道都是 AI 生成之后没有验证就入库的：
 *
 *  - maximum-subarray-sum-with-constraint：题面说「长度至多 k」，参考实现写的是
 *    「长度恰好 k」的定长窗口。而且五个期望输出里有两个（[-1,-2,-3,-4,-5] k=2
 *    声明 -3、[10,-2,3,-1,2,4,-5,6] k=3 声明 12）按题面独立算出来分别是 -1 和 11，
 *    按「恰好 k」算又是另外两个数 —— 没有任何一种读法能同时对上。
 *  - minimum-critical-path-cost：题面把关键路径定义成权重**最大**的那条路径，
 *    然后要求这条路径代价的**最小**值，本身就说不通；参考实现里的注释直接写着
 *    「这里需要一个最小堆，为简单起见换个办法」，然后算了两遍同样的 dp。
 *
 * 列成清单而不是从题库里删掉，是因为删题是内容决定，不该由一个测试文件替作者做。
 * 清单本身是一个闸门：再多出一道对不上的题，下面那条用例就会失败。
 *
 * （array-manipulation-example 有同类问题——题面要求「使数组无序」，却声明
 * [1,2,3,4] 要删 3 个而 [5,6,7,8] 删 0 个，两个都是升序数组——但它连参考实现
 * 都没有，所以落在下面那条「没有参考实现」的清单里。）
 */
const KNOWN_BROKEN = new Set([
  'maximum-subarray-sum-with-constraint',
  'minimum-critical-path-cost',
]);

const withJsSolution = problems.filter(
  (problem) => problem.solution?.js?.trim() && !KNOWN_BROKEN.has(problem.id)
);

describe('the problem library', () => {
  it('is not empty', () => {
    expect(problems.length).toBeGreaterThan(0);
  });

  it('has a JavaScript reference solution for most problems', () => {
    // 没有参考实现的题目无法自动验证，工坊会对此发出警告。这里只盯住比例，
    // 不硬性要求 100%：题库里确实有几道 AI 生成的、还没补上实现的题。
    expect(withJsSolution.length / problems.length).toBeGreaterThan(0.8);
  });

  it('does not grow the list of problems whose solution disagrees with their own tests', () => {
    const broken = problems.filter((problem) => KNOWN_BROKEN.has(problem.id)).map((problem) => problem.id);

    // 修好或者删掉一道之后，把它从 KNOWN_BROKEN 里拿走，这条用例会提醒你
    expect(broken.sort()).toEqual(Array.from(KNOWN_BROKEN).sort());
  });

  it('lists which problems have no reference solution, so the gap is visible', () => {
    const missing = problems
      .filter((problem) => !problem.solution?.js?.trim())
      .map((problem) => problem.id);

    // 断言的是「我们知道有哪些」，不是「一个都没有」。多出来一道就会失败，
    // 逼着加题的人要么补上实现，要么明确承认这道题没法验证。
    expect(missing.sort()).toEqual(
      [
        'array-manipulation-example',
        'binary-search-implementation',
        'minimum-spanning-tree-with-odd-degree-constraint',
      ].sort()
    );
  });
});

describe.each(withJsSolution.map((problem) => [problem.id, problem] as const))(
  '%s',
  (_id, problem) => {
    it('exports a function through module.exports', async () => {
      const outcome = await executeJavaScript(
        problem.solution!.js,
        parseTestInput(problem.tests[0].input),
        Boolean(problem.tags?.includes('linked-list'))
      );

      // 执行器要求 module.exports = fn。没这么写的解法在界面上会直接报这句话，
      // 而不是给出一个错误答案 —— 两种失败的排查方向完全不同。
      expect(outcome.error || '').not.toMatch(/module\.exports/);
    });

    it.each(problem.tests.map((testCase, index) => [index + 1, testCase] as const))(
      'passes test case %i',
      async (_index, testCase) => {
        const args = parseTestInput(testCase.input);
        const expected = JSON.parse(testCase.output);
        const isLinkedList = Boolean(problem.tags?.includes('linked-list'));

        const outcome = await executeJavaScript(problem.solution!.js, args, isLinkedList);

        expect(outcome.error).toBeNull();
        if (!deepEqual(outcome.result, expected)) {
          throw new Error(
            `${problem.id} test "${testCase.input}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(outcome.result)}`
          );
        }
      }
    );
  }
);
