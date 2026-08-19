/**
 * 工程代码的离线静态分析
 *
 * 「优雅程度」「封装」这类维度，AI 评审能给出有洞见的意见，但不可复现、
 * 也需要联网。这里先用一组本地启发式指标打底：函数长度、圈复杂度、重复块、
 * 魔法数字、模块耦合与循环依赖。AI 评审在这之上做定性补充。
 */
import { dirname, joinPath, normalizePath } from './moduleRuntime';
import type { QualityFinding, QualityReport } from './types';

// 只认「说明符本身」的四种写法，避免 import ... from 的跨语句贪婪匹配：
// import/export ... from 'x' / 副作用 import 'x' / require('x') / 动态 import('x')
const IMPORT_PATTERN = /(?:from\s*['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const EXPORT_PATTERN = /export\s+(?:default|(?:async\s+)?function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)?/g;
const FUNCTION_START = /(?:\bfunction\b[^(]*\([^)]*\)\s*\{)|(?:=>\s*\{)|(?:^\s*(?:public|private|protected|static|async|\*)?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{)/;
const BRANCH_PATTERN = /\b(if|for|while|case|catch)\b|&&|\|\||\?\?|\?[^.:]/g;

const DEFAULT_ALLOWED_NUMBERS = new Set(['0', '1', '2', '-1', '100', '1000']);

function stripStringsAndComments(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

interface FunctionStat {
  file: string;
  line: number;
  lines: number;
  complexity: number;
}

/** 用大括号配对粗略切出函数体，够用来判断「这个函数是不是太长了」 */
function collectFunctions(file: string, source: string): FunctionStat[] {
  const lines = source.split('\n');
  const stats: FunctionStat[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripStringsAndComments(lines[index]);
    if (!FUNCTION_START.test(line)) continue;

    let depth = 0;
    let started = false;
    let complexity = 1;
    let end = index;

    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const body = stripStringsAndComments(lines[cursor]);
      complexity += (body.match(BRANCH_PATTERN) || []).length;
      for (const char of body) {
        if (char === '{') {
          depth += 1;
          started = true;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      if (started && depth <= 0) {
        end = cursor;
        break;
      }
      end = cursor;
    }

    stats.push({ file, line: index + 1, lines: end - index + 1, complexity });
    index = end;
  }

  return stats;
}

function countDuplicatedBlocks(files: Record<string, string>, windowSize = 5): number {
  const seen = new Map<string, number>();
  for (const source of Object.values(files)) {
    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isCommentLine(line));
    for (let index = 0; index + windowSize <= lines.length; index += 1) {
      const key = lines.slice(index, index + windowSize).join('\n');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let duplicates = 0;
  for (const count of Array.from(seen.values())) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

export function buildDependencyGraph(files: Record<string, string>): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const paths = Object.keys(files);

  const resolveTo = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null;
    const target = joinPath(dirname(from), specifier);
    const candidates = [target, `${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`];
    return candidates.find((candidate) => paths.includes(normalizePath(candidate))) || null;
  };

  for (const [path, source] of Object.entries(files)) {
    graph[path] = [];
    IMPORT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_PATTERN.exec(source))) {
      const specifier = match[1] || match[2] || match[3] || match[4];
      if (!specifier) continue;
      const resolved = resolveTo(path, specifier);
      if (resolved && resolved !== path && !graph[path].includes(resolved)) {
        graph[path].push(resolved);
      }
    }
  }

  return graph;
}

export function hasCircularDependency(graph: Record<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph[node] || []) {
      if (walk(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  return Object.keys(graph).some((node) => walk(node));
}

export function analyzeWorkspace(files: Record<string, string>): QualityReport {
  const entries = Object.entries(files);
  const findings: QualityFinding[] = [];

  if (entries.length === 0) {
    return {
      encapsulationScore: 0,
      eleganceScore: 0,
      metrics: {
        fileCount: 0,
        totalLines: 0,
        maxFileLines: 0,
        maxFunctionLines: 0,
        averageFunctionLines: 0,
        maxCyclomatic: 0,
        duplicatedBlocks: 0,
        magicNumbers: 0,
        commentRatio: 0,
        maxFanOut: 0,
        hasCycles: false,
        exportSurface: 0,
      },
      findings,
    };
  }

  let totalLines = 0;
  let maxFileLines = 0;
  let commentLines = 0;
  let magicNumbers = 0;
  let exportSurface = 0;
  const functionStats: FunctionStat[] = [];

  for (const [path, source] of entries) {
    const lines = source.split('\n');
    totalLines += lines.length;
    if (lines.length > maxFileLines) maxFileLines = lines.length;
    commentLines += lines.filter(isCommentLine).length;

    for (const line of lines) {
      const cleaned = stripStringsAndComments(line);
      if (/\b(const|readonly|enum)\b/.test(cleaned)) continue;
      const numbers = cleaned.match(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g) || [];
      magicNumbers += numbers.filter((value) => !DEFAULT_ALLOWED_NUMBERS.has(value)).length;
    }

    EXPORT_PATTERN.lastIndex = 0;
    while (EXPORT_PATTERN.exec(source)) exportSurface += 1;

    functionStats.push(...collectFunctions(path, source));

    if (lines.length > 320) {
      findings.push({
        severity: 'warn',
        file: path,
        message: {
          zh: `${path} 有 ${lines.length} 行，考虑按职责拆分成更小的模块`,
          en: `${path} is ${lines.length} lines long — consider splitting it by responsibility`,
        },
      });
    }
  }

  const graph = buildDependencyGraph(files);
  const maxFanOut = Math.max(0, ...Object.values(graph).map((deps) => deps.length));
  const cycles = hasCircularDependency(graph);
  const duplicatedBlocks = countDuplicatedBlocks(files);

  const maxFunctionLines = Math.max(0, ...functionStats.map((stat) => stat.lines));
  const averageFunctionLines = functionStats.length
    ? functionStats.reduce((sum, stat) => sum + stat.lines, 0) / functionStats.length
    : 0;
  const maxCyclomatic = Math.max(0, ...functionStats.map((stat) => stat.complexity));
  const commentRatio = totalLines ? commentLines / totalLines : 0;

  const longest = functionStats.slice().sort((a, b) => b.lines - a.lines)[0];
  if (longest && longest.lines > 60) {
    findings.push({
      severity: longest.lines > 120 ? 'error' : 'warn',
      file: longest.file,
      line: longest.line,
      message: {
        zh: `最长的函数有 ${longest.lines} 行（${longest.file}:${longest.line}），拆分后更容易测试与复用`,
        en: `The longest function spans ${longest.lines} lines (${longest.file}:${longest.line}) — split it for testability`,
      },
    });
  }

  const mostComplex = functionStats.slice().sort((a, b) => b.complexity - a.complexity)[0];
  if (mostComplex && mostComplex.complexity > 12) {
    findings.push({
      severity: 'warn',
      file: mostComplex.file,
      line: mostComplex.line,
      message: {
        zh: `圈复杂度最高为 ${mostComplex.complexity}（${mostComplex.file}:${mostComplex.line}），分支过多会让边界条件难以覆盖`,
        en: `Peak cyclomatic complexity is ${mostComplex.complexity} (${mostComplex.file}:${mostComplex.line}) — too many branches to cover`,
      },
    });
  }

  if (duplicatedBlocks > 0) {
    findings.push({
      severity: duplicatedBlocks > 4 ? 'warn' : 'info',
      message: {
        zh: `检测到 ${duplicatedBlocks} 处 5 行以上的重复代码块，考虑抽成公共函数`,
        en: `Found ${duplicatedBlocks} duplicated 5-line blocks — extract them into shared helpers`,
      },
    });
  }

  if (cycles) {
    findings.push({
      severity: 'error',
      message: {
        zh: '模块之间存在循环依赖，说明边界划分有问题',
        en: 'Modules form a dependency cycle — the boundaries are leaking',
      },
    });
  }

  if (maxFanOut > 6) {
    findings.push({
      severity: 'warn',
      message: {
        zh: `某个模块直接依赖了 ${maxFanOut} 个模块，耦合偏高`,
        en: `One module directly depends on ${maxFanOut} others — coupling is high`,
      },
    });
  }

  if (entries.length === 1 && totalLines > 120) {
    findings.push({
      severity: 'warn',
      message: {
        zh: '所有逻辑都写在一个文件里，缺少模块边界',
        en: 'Everything lives in a single file — there are no module boundaries',
      },
    });
  }

  // ---- 打分 ----
  let elegance = 100;
  elegance -= Math.max(0, maxFunctionLines - 50) * 0.6;
  elegance -= Math.max(0, maxCyclomatic - 10) * 2;
  elegance -= Math.min(20, duplicatedBlocks * 4);
  elegance -= Math.min(12, Math.max(0, magicNumbers - 6) * 0.8);
  elegance -= Math.max(0, maxFileLines - 300) * 0.05;
  if (commentRatio > 0.03) elegance += 4;
  if (commentRatio > 0.3) elegance -= 6;

  let encapsulation = 100;
  encapsulation -= Math.max(0, maxFanOut - 4) * 6;
  if (cycles) encapsulation -= 25;
  if (entries.length === 1 && totalLines > 120) encapsulation -= 22;
  encapsulation -= Math.max(0, exportSurface / Math.max(1, entries.length) - 6) * 3;
  encapsulation -= Math.max(0, maxFileLines - 250) * 0.08;
  if (entries.length >= 3 && !cycles && maxFanOut <= 4) encapsulation += 5;

  const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

  return {
    encapsulationScore: clamp(encapsulation),
    eleganceScore: clamp(elegance),
    metrics: {
      fileCount: entries.length,
      totalLines,
      maxFileLines,
      maxFunctionLines,
      averageFunctionLines: Math.round(averageFunctionLines * 10) / 10,
      maxCyclomatic,
      duplicatedBlocks,
      magicNumbers,
      commentRatio: Math.round(commentRatio * 1000) / 1000,
      maxFanOut,
      hasCycles: cycles,
      exportSurface,
    },
    findings,
  };
}
