/**
 * 算法题的规整与校验
 *
 * 这一层是「不信任输入」的第一道关：题目可能来自手写、AI 生成、导入的 JSON，
 * 或者市场上别人上传的包。它的职责不是把坏数据修好，而是把结构不合法的东西
 * 拦下来，并且说清楚坏在哪一个字段。
 */
import {
  coerceProblem,
  hasBlockingIssues,
  isValidProblemId,
  normalizeLocalized,
  slugifyProblemId,
  validateProblem,
} from '../../src/lib/workshop/problem';
import { blankAlgorithmProblem } from '../../src/lib/workshop/templates';

describe('id handling', () => {
  it('accepts kebab-case ids of a sane length', () => {
    expect(isValidProblemId('two-sum')).toBe(true);
    expect(isValidProblemId('a1-b2-c3')).toBe(true);

    expect(isValidProblemId('Two-Sum')).toBe(false);
    expect(isValidProblemId('two_sum')).toBe(false);
    expect(isValidProblemId('-leading')).toBe(false);
    expect(isValidProblemId('trailing-')).toBe(false);
    expect(isValidProblemId('ab')).toBe(false);
    expect(isValidProblemId('a'.repeat(65))).toBe(false);
  });

  it('slugifies anything into a usable id', () => {
    expect(slugifyProblemId('Two Sum')).toBe('two-sum');
    expect(slugifyProblemId('  Binary Search!! ')).toBe('binary-search');
    expect(slugifyProblemId('两数之和')).toBe('untitled-problem');
    expect(slugifyProblemId('')).toBe('untitled-problem');
    // 截断之后不能留一个尾随连字符，那会让 id 变成非法值
    expect(slugifyProblemId('a'.repeat(70))).not.toMatch(/-$/);
    expect(isValidProblemId(slugifyProblemId('x'.repeat(70)))).toBe(true);
  });
});

describe('localized text', () => {
  it('fills the missing language from the one that is there', () => {
    expect(normalizeLocalized({ zh: '只有中文' })).toEqual({ zh: '只有中文', en: '只有中文' });
    expect(normalizeLocalized('a plain string')).toEqual({ zh: 'a plain string', en: 'a plain string' });
    expect(normalizeLocalized(null, 'fallback')).toEqual({ zh: 'fallback', en: 'fallback' });
    expect(normalizeLocalized(42)).toEqual({ zh: '', en: '' });
  });
});

describe('coerceProblem', () => {
  it('survives complete garbage', () => {
    expect(() => coerceProblem(null)).not.toThrow();
    expect(() => coerceProblem('a string')).not.toThrow();
    expect(() => coerceProblem({ tests: 'not an array', template: 42 })).not.toThrow();

    const problem = coerceProblem({});
    expect(problem.tests).toEqual([]);
    expect(problem.template).toEqual({});
    expect(problem.difficulty).toBe('Medium');
  });

  it('drops non-string code and keeps the rest', () => {
    const problem = coerceProblem({
      id: 'x',
      template: { js: 'function f() {}', python: 42, java: null },
    });

    expect(Object.keys(problem.template)).toEqual(['js']);
  });

  it('deduplicates and lowercases tags, and caps how many there are', () => {
    const problem = coerceProblem({
      tags: ['Array', 'array', ' ARRAY ', ...Array.from({ length: 20 }, (_, index) => `tag-${index}`)],
    });

    expect(problem.tags[0]).toBe('array');
    expect(problem.tags.filter((tag) => tag === 'array')).toHaveLength(1);
    expect(problem.tags.length).toBeLessThanOrEqual(12);
  });

  it('caps the number of test cases so one upload cannot be a data dump', () => {
    const problem = coerceProblem({
      tests: Array.from({ length: 500 }, (_, index) => ({ input: String(index), output: String(index) })),
    });

    expect(problem.tests.length).toBeLessThanOrEqual(200);
  });

  it('leaves a well-formed problem alone', () => {
    const original = blankAlgorithmProblem();
    const coerced = coerceProblem(original);

    expect(coerced).toEqual(original);
  });
});

describe('validateProblem', () => {
  const errorsOf = (problem: any) =>
    validateProblem(problem).filter((issue) => issue.severity === 'error').map((issue) => issue.field);

  it('passes the starter template', () => {
    const issues = validateProblem(blankAlgorithmProblem());
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('blocks a problem with no test cases', () => {
    expect(errorsOf({ ...blankAlgorithmProblem(), tests: [] })).toContain('tests');
  });

  it('blocks a test case with no expected output', () => {
    const problem = { ...blankAlgorithmProblem(), tests: [{ input: '1,2', output: '  ' }] };
    expect(errorsOf(problem)).toContain('tests.0');
  });

  it('blocks a problem with no runnable template', () => {
    const problem = coerceProblem({
      ...blankAlgorithmProblem(),
      template: { java: 'class Solution {}' },
    });

    // Java 模板在这个应用里跑不起来，只有它等于「点提交什么都不会发生」
    expect(errorsOf(problem)).toContain('template');
  });

  it('blocks an empty statement but only warns on a single language', () => {
    expect(errorsOf({ ...blankAlgorithmProblem(), description: { en: '', zh: '' } })).toContain('description');

    const oneLanguage = validateProblem({ ...blankAlgorithmProblem(), description: { en: 'Only English', zh: '' } });
    expect(hasBlockingIssues(oneLanguage)).toBe(false);
    expect(oneLanguage.some((issue) => issue.field === 'description' && issue.severity === 'warning')).toBe(true);
  });

  it('blocks a bad id and a missing title', () => {
    expect(errorsOf({ ...blankAlgorithmProblem(), id: 'Not Valid' })).toContain('id');
    expect(errorsOf({ ...blankAlgorithmProblem(), title: { en: 'Only English', zh: '' } })).toContain('title');
  });

  it('warns about the things that are merely thin', () => {
    const thin = validateProblem({
      ...blankAlgorithmProblem(),
      tags: [],
      examples: [],
      solution: undefined,
      tests: [{ input: '1,2', output: '3' }],
    } as any);

    const warnings = thin.filter((issue) => issue.severity === 'warning').map((issue) => issue.field);
    expect(warnings).toEqual(expect.arrayContaining(['tags', 'examples', 'solution', 'tests']));
    expect(hasBlockingIssues(thin)).toBe(false);
  });

  it('reports both languages of every message', () => {
    for (const issue of validateProblem(coerceProblem({}))) {
      expect(issue.message.en.length).toBeGreaterThan(0);
      expect(issue.message.zh.length).toBeGreaterThan(0);
    }
  });
});
