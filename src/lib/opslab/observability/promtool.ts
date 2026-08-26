/**
 * `promtool`
 *
 * 真 promtool 会做的三件里，这里做两件：查一条 PromQL、检查规则文件。
 * 第三件（单元测试规则）依赖一整套 YAML 夹具格式，教学价值不如前两件。
 *
 * `query instant` 打出来的格式照抄真 promtool —— 学员在这里练出来的读法
 * 要能带走。
 */
import type { CommandHandler, CommandResult } from '../../labkit/machine/shell/shell';
import { evaluate, parseDuration, PromqlError } from './promql';
import { Tsdb } from './tsdb';
import { parseYamlAll } from '../yaml';

export interface PromtoolOptions {
  /** 去哪个 Prometheus 查。地址对不上就是连不上。 */
  tsdb(address: string): Tsdb | undefined;
  now(): number;
}

export function createPromtoolCommand(options: PromtoolOptions): CommandHandler {
  return ({ argv, cwd, vfs }) => {
    const [command, ...rest] = argv;
    if (command === '--version' || command === 'version') {
      return { stdout: 'promtool, version 3.9.1\n' };
    }
    if (command === 'query') return query(rest, options);
    if (command === 'check') return check(rest, cwd, vfs);
    return {
      stdout: 'usage: promtool [<flags>] <command> [<args> ...]\n\n'
        + '  query instant <server> <expr>   Run an instant query\n'
        + '  check rules <file>              Check rule files for syntax errors\n',
      code: command ? 1 : 0,
    };
  };
}

function query(argv: string[], options: PromtoolOptions): CommandResult {
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  if (positional[0] !== 'instant') {
    return { stderr: 'promtool: 只做了 query instant\n', code: 1 };
  }
  const [, address, ...expression] = positional;
  if (!address || expression.length === 0) {
    return { stderr: 'usage: promtool query instant <server> <expr>\n', code: 1 };
  }
  const tsdb = options.tsdb(address);
  if (!tsdb) {
    return {
      stderr: `query error: Post "${address}/api/v1/query": dial tcp: `
        + `lookup ${hostOf(address)}: no such host\n`,
      code: 1,
    };
  }
  try {
    const results = evaluate(tsdb, expression.join(' '), options.now());
    if (results.length === 0) return { stdout: '' };
    return {
      stdout: results
        .map((entry) => {
          const labels = Object.entries(entry.labels)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => `${key}="${value}"`)
            .join(', ');
          return `{${labels}} => ${format(entry.value)} @[${(options.now() / 1000).toFixed(3)}]`;
        })
        .join('\n') + '\n',
    };
  } catch (error) {
    if (error instanceof PromqlError) {
      return { stderr: `query error: ${error.message}\n`, code: 1 };
    }
    throw error;
  }
}

/**
 * `promtool check rules`
 *
 * 查的是**能不能解析**与**字段齐不齐**，不查语义。上线前跑一次能挡掉
 * 一大半「规则装上去了但从不触发」的情况 —— 那多半是表达式写错了，
 * 而 apiserver 收 PrometheusRule 的时候不会校验表达式。
 */
function check(argv: string[], cwd: string, vfs: { exists(path: string): boolean; readFile(path: string): string }): CommandResult {
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  if (positional[0] !== 'rules' || !positional[1]) {
    return { stderr: 'usage: promtool check rules <file>\n', code: 1 };
  }
  const path = positional[1].startsWith('/') ? positional[1] : `${cwd}/${positional[1]}`;
  if (!vfs.exists(path)) {
    return { stderr: `cannot read ${positional[1]}: no such file or directory\n`, code: 1 };
  }

  const problems: string[] = [];
  let count = 0;
  for (const document of parseYamlAll(vfs.readFile(path))) {
    const groups = ((document as any)?.spec?.groups ?? (document as any)?.groups ?? []) as any[];
    for (const group of groups) {
      for (const rule of group.rules ?? []) {
        count += 1;
        const label = rule.alert ?? rule.record ?? '<unnamed>';
        if (!rule.expr) {
          problems.push(`  ${label}: field 'expr' must be set in rule`);
          continue;
        }
        try {
          // 只解析不求值：没有数据也能查出语法错
          evaluate(emptyTsdb(), String(rule.expr), 0);
        } catch (error) {
          if (error instanceof PromqlError) {
            problems.push(`  ${label}: could not parse expression: ${error.message}`);
          } else throw error;
        }
        if (rule.for) {
          try {
            parseDuration(String(rule.for));
          } catch {
            problems.push(`  ${label}: invalid duration ${JSON.stringify(rule.for)} in 'for'`);
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    return {
      stdout: `Checking ${positional[1]}\n  FAILED:\n${problems.join('\n')}\n`,
      code: 1,
    };
  }
  return { stdout: `Checking ${positional[1]}\n  SUCCESS: ${count} rules found\n` };
}

/** 只为语法检查用的空库。没有数据也能查出语法错。 */
function emptyTsdb(): Tsdb {
  return new Tsdb();
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
}

function hostOf(address: string): string {
  return address.replace(/^[a-z]+:\/\//, '').split(/[:/]/)[0];
}
