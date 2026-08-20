/**
 * 算法题的数据模型、规整与校验
 *
 * 题库原本只是一个手写的 JSON 文件，没有类型也没有校验 —— 自己写的时候
 * 尚可，一旦题目来自工坊、AI 生成或者别人上传的市场包，就必须有一层
 * 「不信任输入」的处理。这个模块是那一层，客户端和服务端共用。
 *
 * 只依赖标准库，因为它同时被浏览器 bundle 和 API 路由引用。
 */

export interface LocalizedText {
  en: string;
  zh: string;
}

export type ProblemDifficulty = 'Easy' | 'Medium' | 'Hard';

export interface ProblemExample {
  input: string;
  output: string;
  explanation?: LocalizedText;
}

export interface ProblemTestCase {
  input: string;
  output: string;
}

export interface ProblemSolutionArticle {
  title: LocalizedText;
  content: LocalizedText;
}

export interface AlgorithmProblem {
  id: string;
  title: LocalizedText;
  difficulty: ProblemDifficulty;
  tags: string[];
  description: LocalizedText;
  examples: ProblemExample[];
  /** 各语言的初始模板，至少要有一个 */
  template: Record<string, string>;
  /** 参考实现，键是语言 */
  solution?: Record<string, string>;
  /** 题解文章 */
  solutions?: ProblemSolutionArticle[];
  tests: ProblemTestCase[];
}

export const PROBLEM_DIFFICULTIES: ProblemDifficulty[] = ['Easy', 'Medium', 'Hard'];

/** 题库里实际用到的语言，顺序即模板编辑器里的标签顺序 */
export const PROBLEM_LANGUAGES = ['js', 'python', 'java', 'cpp', 'c'] as const;
export type ProblemLanguage = (typeof PROBLEM_LANGUAGES)[number];

/** 能在本地真正跑起来的语言，其余的模板只是给人看的 */
export const RUNNABLE_LANGUAGES: ProblemLanguage[] = ['js', 'python'];

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidProblemId(id: string): boolean {
  return typeof id === 'string' && id.length >= 3 && id.length <= 64 && ID_RE.test(id);
}

export function slugifyProblemId(input: string): string {
  const base = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return base || 'untitled-problem';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeLocalized(value: unknown, fallback = ''): LocalizedText {
  if (typeof value === 'string') return { en: value, zh: value };
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const en = text(record.en);
    const zh = text(record.zh);
    // 只写了一种语言时用它兜另一种，总比界面上出现空白强
    return { en: en || zh || fallback, zh: zh || en || fallback };
  }
  return { en: fallback, zh: fallback };
}

/** 把任意来源的数据规整成 AlgorithmProblem。不做校验，校验由 validateProblem 负责。 */
export function coerceProblem(raw: unknown): AlgorithmProblem {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;

  const template: Record<string, string> = {};
  if (source.template && typeof source.template === 'object') {
    for (const [language, code] of Object.entries(source.template)) {
      if (typeof code === 'string') template[language] = code;
    }
  }

  const solution: Record<string, string> = {};
  if (source.solution && typeof source.solution === 'object') {
    for (const [language, code] of Object.entries(source.solution)) {
      if (typeof code === 'string') solution[language] = code;
    }
  }

  return {
    id: slugifyProblemId(source.id || normalizeLocalized(source.title).en),
    title: normalizeLocalized(source.title, 'Untitled problem'),
    difficulty: PROBLEM_DIFFICULTIES.includes(source.difficulty) ? source.difficulty : 'Medium',
    tags: Array.isArray(source.tags)
      ? Array.from(new Set(source.tags.map((tag: unknown) => text(tag).trim().toLowerCase()).filter(Boolean))).slice(0, 12)
      : [],
    description: normalizeLocalized(source.description),
    examples: Array.isArray(source.examples)
      ? source.examples
          .filter((example: any) => example && (typeof example.input === 'string' || typeof example.output === 'string'))
          .map((example: any) => ({
            input: text(example.input),
            output: text(example.output),
            ...(example.explanation ? { explanation: normalizeLocalized(example.explanation) } : {}),
          }))
          .slice(0, 20)
      : [],
    template,
    ...(Object.keys(solution).length ? { solution } : {}),
    ...(Array.isArray(source.solutions) && source.solutions.length
      ? {
          solutions: source.solutions
            .filter((article: any) => article && typeof article === 'object')
            .map((article: any) => ({
              title: normalizeLocalized(article.title, 'Approach'),
              content: normalizeLocalized(article.content),
            }))
            .slice(0, 10),
        }
      : {}),
    tests: Array.isArray(source.tests)
      ? source.tests
          .filter((testCase: any) => testCase && typeof testCase === 'object')
          .map((testCase: any) => ({ input: text(testCase.input), output: text(testCase.output) }))
          .slice(0, 200)
      : [],
  };
}

export interface ValidationIssue {
  /** 出问题的字段，界面用它把错误定位到对应的输入框 */
  field: string;
  message: LocalizedText;
  severity: 'error' | 'warning';
}

const MAX_DESCRIPTION = 20000;
const MAX_CODE = 60000;

/**
 * 结构校验。error 会挡住发布，warning 只提示。
 *
 * 分两级的原因是：没有题解文章、只写了一种语言的模板，都不影响题目能用；
 * 但没有测试用例的题目点「提交」之后什么也不会发生，那是坏的。
 */
export function validateProblem(problem: AlgorithmProblem): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const error = (field: string, en: string, zh: string) =>
    issues.push({ field, severity: 'error', message: { en, zh } });
  const warn = (field: string, en: string, zh: string) =>
    issues.push({ field, severity: 'warning', message: { en, zh } });

  if (!isValidProblemId(problem.id)) {
    error('id', 'ID must be 3-64 characters of lowercase letters, digits and hyphens', 'ID 只能由小写字母、数字和连字符组成，长度 3~64');
  }

  if (!problem.title.en.trim() || !problem.title.zh.trim()) {
    error('title', 'Both English and Chinese titles are required', '中英文标题都必须填写');
  } else if (problem.title.en.length > 200 || problem.title.zh.length > 200) {
    error('title', 'Titles must be at most 200 characters', '标题最长 200 个字符');
  }

  if (!PROBLEM_DIFFICULTIES.includes(problem.difficulty)) {
    error('difficulty', 'Difficulty must be Easy, Medium or Hard', '难度必须是 Easy、Medium 或 Hard');
  }

  if (!problem.description.en.trim() && !problem.description.zh.trim()) {
    error('description', 'The problem statement is empty', '题面是空的');
  } else if (!problem.description.en.trim() || !problem.description.zh.trim()) {
    warn('description', 'Only one language has a statement; the other falls back to it', '只填了一种语言的题面，另一种会回退显示它');
  }

  if (problem.description.en.length > MAX_DESCRIPTION || problem.description.zh.length > MAX_DESCRIPTION) {
    error('description', `The statement must be at most ${MAX_DESCRIPTION} characters`, `题面最长 ${MAX_DESCRIPTION} 个字符`);
  }

  const templateLanguages = Object.keys(problem.template).filter((language) => problem.template[language].trim());
  if (!templateLanguages.length) {
    error('template', 'At least one language template is required', '至少要有一种语言的初始模板');
  }
  if (!templateLanguages.some((language) => RUNNABLE_LANGUAGES.includes(language as ProblemLanguage))) {
    error('template', 'Add a JavaScript or Python template — the other languages cannot run locally', '需要 JavaScript 或 Python 模板，其他语言在本地跑不起来');
  }
  for (const [language, code] of Object.entries(problem.template)) {
    if (code.length > MAX_CODE) {
      error(`template.${language}`, `The ${language} template is too long`, `${language} 模板过长`);
    }
  }

  if (!problem.tests.length) {
    error('tests', 'Add at least one test case', '至少要有一个测试用例');
  }
  problem.tests.forEach((testCase, index) => {
    if (!testCase.input.trim() && !testCase.output.trim()) {
      error(`tests.${index}`, `Test case ${index + 1} is empty`, `第 ${index + 1} 个测试用例是空的`);
    } else if (!testCase.output.trim()) {
      error(`tests.${index}`, `Test case ${index + 1} has no expected output`, `第 ${index + 1} 个测试用例没有期望输出`);
    }
  });

  if (problem.tests.length < 3) {
    warn('tests', 'Fewer than three test cases rarely covers the edge cases', '少于三个用例通常盖不住边界情况');
  }

  if (!problem.tags.length) {
    warn('tags', 'Tags make the problem findable', '标签会影响这道题能不能被搜到');
  }

  if (!problem.solution || !Object.keys(problem.solution).length) {
    warn('solution', 'Without a reference solution the test cases cannot be checked automatically', '没有参考实现就无法自动验证测试用例');
  }

  if (!problem.examples.length) {
    warn('examples', 'Examples make the statement much easier to read', '示例能让题面好读很多');
  }

  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
