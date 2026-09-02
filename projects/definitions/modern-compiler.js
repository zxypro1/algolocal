/**
 * 工程实战 · 从 0 写一个现代编译系统
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 第 1 关 · Lexer                                                    */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'lexer-spans',
  title: t('第 1 关 · Token、源码位置与错误边界', 'Stage 1 · Tokens, source spans and lexical errors'),
  goal: t(
    [
      '编译器后面的每一条错误信息都要回到源码位置。Lexer 如果只返回字符串，解析器和类型检查器就只能报一个没有上下文的错误。',
      '',
      '在 `src/lexer.ts` 实现 `tokenize(source)`：',
      '',
      '- 识别整数、标识符、关键字、操作符和标点；',
      '- 优先匹配 `==`、`!=`、`<=`、`>=` 和 `->` 这类双字符操作符；',
      '- 跳过空白和 `//` 行注释；',
      '- 每个 token 保存 start、end、line 和 column，end 使用半开区间；',
      '- 未知字符抛出 `LexError`，并保留准确位置；',
      '- 最后追加一个 eof token。',
      '',
      '位置计算要和消费字符同时发生。先删注释和空白再扫描，会让 token 的 offset 无法对应原文件。',
    ].join('\n'),
    [
      'Every later diagnostic must point back to source. If the lexer returns only strings, the parser and',
      'type checker can report an error but cannot show where it came from.',
      '',
      'Implement `tokenize(source)` in `src/lexer.ts`:',
      '',
      '- Recognise integers, identifiers, keywords, operators and punctuation;',
      '- Prefer two-character operators such as `==`, `!=`, `<=`, `>=` and `->`;',
      '- Skip whitespace and `//` line comments;',
      '- Keep start, end, line and column on every token, using a half-open end offset;',
      '- Throw `LexError` with the exact position for an unknown character;',
      '- Append one eof token.',
      '',
      'Position tracking must advance with character consumption. Stripping comments and whitespace first',
      'breaks the connection between token offsets and the original file.',
    ].join('\n')
  ),
  checklist: [
    t('双字符操作符优先于单字符操作符', 'Two-character operators take priority'),
    t('注释不会产生 token，也不会破坏行列号', 'Comments produce no tokens and preserve positions'),
    t('token span 使用半开区间', 'Token spans use half-open offsets'),
    t('非法字符带准确位置报错', 'Illegal characters report the exact position'),
  ],
  hints: [
    t('封装一个 advance，每消费字符就同时更新 offset、line 和 column。', 'Use one advance helper that updates offset, line and column together.'),
    t('标识符规则可以从 ASCII 字母和下划线开始，后续允许数字。', 'Identifiers may start with an ASCII letter or underscore and continue with digits.'),
  ],
  pitfalls: [
    t('先匹配单个 `=`，会把 `==` 错拆成两个 token。', 'Matching a single `=` first splits `==` into two tokens.'),
    t('用 split 预处理源码会丢失 token 在原文本中的绝对 offset。', 'Preprocessing with split loses absolute offsets in the original source.'),
  ],
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/lexer.ts',
      code`
        export type TokenKind = 'number' | 'identifier' | 'keyword' | 'operator' | 'punctuation' | 'eof';

        export interface Token {
          kind: TokenKind;
          text: string;
          start: number;
          end: number;
          line: number;
          column: number;
        }

        export class LexError extends Error {
          constructor(message: string, public offset: number, public line: number, public column: number) {
            super(message);
            this.name = 'LexError';
          }
        }

        export function tokenize(source: string): Token[] {
          // TODO: scan source without losing the original positions
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-1.spec.ts',
      code`
        import { tokenize, LexError } from '../src/lexer';

        describe('Stage 1 · Lexer', () => {
          it('recognises keywords, identifiers, numbers and punctuation', () => {
            const tokens = tokenize('let answer = 42;');
            expect(tokens.map((token) => [token.kind, token.text])).toEqual([
              ['keyword', 'let'],
              ['identifier', 'answer'],
              ['operator', '='],
              ['number', '42'],
              ['punctuation', ';'],
              ['eof', ''],
            ]);
          });

          it('prefers the longest operator', () => {
            const tokens = tokenize('a==b != c <= d >= e -> f');
            expect(tokens.filter((token) => token.kind === 'operator').map((token) => token.text)).toEqual([
              '==', '!=', '<=', '>=', '->',
            ]);
          });

          it('keeps exact half-open source spans', () => {
            const source = 'let value = 123';
            const token = tokenize(source)[1];
            expect(source.slice(token.start, token.end)).toBe('value');
            expect([token.start, token.end, token.line, token.column]).toEqual([4, 9, 1, 5]);
          });

          it('skips comments while preserving the next line and column', () => {
            /* The raw definition keeps the original escape example for readers.
            const tokens = tokenize('// heading\n  return x');
            */
            const tokens = tokenize('// heading' + String.fromCharCode(10) + '  return x');
            expect(tokens[0].text).toBe('return');
            expect([tokens[0].line, tokens[0].column]).toEqual([2, 3]);
            expect(tokens[1].text).toBe('x');
          });

          it('allows digits after the first identifier character', () => {
            expect(tokenize('_tmp2 value9').slice(0, 2).map((token) => token.text)).toEqual(['_tmp2', 'value9']);
          });

          it('reports the exact location of an illegal character', () => {
            let found: LexError | null = null;
            /* Keep the source example visible without letting the outer definition consume its escape.
            try { tokenize('let x\n  @'); } catch (error) { found = error as LexError; }
            */
            try { tokenize('let x' + String.fromCharCode(10) + '  @'); } catch (error) { found = error as LexError; }
            expect(found?.name).toBe('LexError');
            expect([found?.offset, found?.line, found?.column]).toEqual([8, 2, 3]);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/lexer.ts',
      code`
        export type TokenKind = 'number' | 'identifier' | 'keyword' | 'operator' | 'punctuation' | 'eof';

        export interface Token {
          kind: TokenKind;
          text: string;
          start: number;
          end: number;
          line: number;
          column: number;
        }

        export class LexError extends Error {
          constructor(message: string, public offset: number, public line: number, public column: number) {
            super(message);
            this.name = 'LexError';
          }
        }

        const KEYWORDS = new Set(['let', 'fn', 'return', 'if', 'else', 'true', 'false']);
        const DOUBLE_OPERATORS = new Set(['==', '!=', '<=', '>=', '->']);
        const SINGLE_OPERATORS = new Set(['+', '-', '*', '/', '=', '<', '>', '!']);
        const PUNCTUATION = new Set(['(', ')', '{', '}', '[', ']', ',', ';', ':']);

        export function tokenize(source: string): Token[] {
          const tokens: Token[] = [];
          let offset = 0;
          let line = 1;
          let column = 1;

          function advance(): string {
            const character = source[offset];
            offset += 1;
            if (character.charCodeAt(0) === 10) {
              line += 1;
              column = 1;
            } else {
              column += 1;
            }
            return character;
          }

          function push(kind: TokenKind, text: string, start: number, startLine: number, startColumn: number): void {
            tokens.push({ kind, text, start, end: offset, line: startLine, column: startColumn });
          }

          while (offset < source.length) {
            const character = source[offset];
            if (
              character === ' ' ||
              character.charCodeAt(0) === 9 ||
              character.charCodeAt(0) === 10 ||
              character.charCodeAt(0) === 13
            ) {
              advance();
              continue;
            }
            if (character === '/' && source[offset + 1] === '/') {
              while (offset < source.length && source.charCodeAt(offset) !== 10) advance();
              continue;
            }

            const start = offset;
            const startLine = line;
            const startColumn = column;

            if (/[A-Za-z_]/.test(character)) {
              let text = '';
              while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset])) text += advance();
              push(KEYWORDS.has(text) ? 'keyword' : 'identifier', text, start, startLine, startColumn);
              continue;
            }
            if (/[0-9]/.test(character)) {
              let text = '';
              while (offset < source.length && /[0-9]/.test(source[offset])) text += advance();
              push('number', text, start, startLine, startColumn);
              continue;
            }

            const pair = source.slice(offset, offset + 2);
            if (DOUBLE_OPERATORS.has(pair)) {
              advance();
              advance();
              push('operator', pair, start, startLine, startColumn);
              continue;
            }
            if (SINGLE_OPERATORS.has(character)) {
              advance();
              push('operator', character, start, startLine, startColumn);
              continue;
            }
            if (PUNCTUATION.has(character)) {
              advance();
              push('punctuation', character, start, startLine, startColumn);
              continue;
            }
            throw new LexError('unexpected character ' + character, offset, line, column);
          }

          tokens.push({ kind: 'eof', text: '', start: offset, end: offset, line, column });
          return tokens;
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · Pratt Parser                                             */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'pratt-parser',
  title: t('第 2 关 · Pratt 表达式解析器', 'Stage 2 · A Pratt expression parser'),
  goal: t(
    [
      '表达式语法同时包含前缀、一元、二元和调用。如果每加一个操作符就新写一层递归函数，优先级表很快会散落到控制流里。',
      '',
      '在 `src/parser.ts` 实现 `parseExpression(source)`：',
      '',
      '- 支持数字、标识符、括号和一元负号；',
      '- 支持 `+`、`-`、`*`、`/`、比较与相等操作；',
      '- 函数调用的优先级高于所有二元操作；',
      '- 二元操作左结合，乘除高于加减，比较低于算术；',
      '- 每个 AST 节点覆盖完整源码 span；',
      '- 表达式结束后还有 token 时明确报错。',
      '',
      'Pratt 解析的核心是一张 binding power 表。语法优先级放在数据里，比藏在多层函数调用里更容易扩展和检查。',
    ].join('\n'),
    [
      'Expressions combine prefix, unary, binary and call syntax. Adding another recursive function for',
      'every operator soon spreads precedence rules through control flow.',
      '',
      'Implement `parseExpression(source)` in `src/parser.ts`:',
      '',
      '- Support numbers, identifiers, parentheses and unary minus;',
      '- Support `+`, `-`, `*`, `/`, comparison and equality operators;',
      '- Function calls bind more tightly than every binary operator;',
      '- Binary operators associate left, multiplication beats addition, and comparisons follow arithmetic;',
      '- Every AST node covers its complete source span;',
      '- Report trailing tokens after the expression.',
      '',
      'The heart of a Pratt parser is a binding-power table. Keeping precedence in data makes the grammar',
      'easier to extend and inspect than hiding it in nested functions.',
    ].join('\n')
  ),
  checklist: [
    t('乘除优先于加减', 'Multiplication and division bind above addition and subtraction'),
    t('二元操作左结合', 'Binary operators associate left'),
    t('调用表达式拥有最高优先级', 'Call expressions have the highest precedence'),
    t('AST span 覆盖完整子表达式', 'AST spans cover each complete subexpression'),
  ],
  hints: [
    t('parse(minBp) 先读前缀，再循环处理 binding power 足够高的后缀。', '`parse(minBp)` reads a prefix, then loops over suffixes with sufficient binding power.'),
    t('左结合操作符可以使用 leftBp 和 leftBp + 1。', 'A left-associative operator can use leftBp and leftBp + 1.'),
  ],
  pitfalls: [
    t('括号表达式的 span 只保留内部节点，会让诊断高亮漏掉左右括号。', 'Keeping only the inner span for parentheses makes diagnostics omit both parentheses.'),
    t('解析出一个 AST 就立刻返回，会静默忽略尾部垃圾 token。', 'Returning after one AST silently ignores trailing garbage tokens.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/parser.ts',
      code`
        import { tokenize, type Token } from './lexer';

        export type Expression =
          | { kind: 'number'; value: number; start: number; end: number }
          | { kind: 'identifier'; name: string; start: number; end: number }
          | { kind: 'unary'; operator: string; operand: Expression; start: number; end: number }
          | { kind: 'binary'; operator: string; left: Expression; right: Expression; start: number; end: number }
          | { kind: 'call'; callee: Expression; args: Expression[]; start: number; end: number };

        export function parseExpression(source: string): Expression {
          // TODO: implement Pratt parsing over tokenize(source)
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-2.spec.ts',
      code`
        import { parseExpression } from '../src/parser';

        function shape(expression: any): any {
          if (expression.kind === 'number') return expression.value;
          if (expression.kind === 'identifier') return expression.name;
          if (expression.kind === 'unary') return [expression.operator, shape(expression.operand)];
          if (expression.kind === 'binary') return [expression.operator, shape(expression.left), shape(expression.right)];
          return ['call', shape(expression.callee), expression.args.map(shape)];
        }

        function throws(source: string): boolean {
          try { parseExpression(source); return false; } catch (error) { return true; }
        }

        describe('Stage 2 · Pratt parser', () => {
          it('applies multiplication before addition', () => {
            expect(shape(parseExpression('1 + 2 * 3'))).toEqual(['+', 1, ['*', 2, 3]]);
          });

          it('associates subtraction to the left', () => {
            expect(shape(parseExpression('10 - 3 - 2'))).toEqual(['-', ['-', 10, 3], 2]);
          });

          it('lets parentheses override precedence and includes them in the span', () => {
            const expression = parseExpression('(1 + 2) * 3');
            expect(shape(expression)).toEqual(['*', ['+', 1, 2], 3]);
            expect([expression.start, expression.end]).toEqual([0, 11]);
            expect([(expression as any).left.start, (expression as any).left.end]).toEqual([0, 7]);
          });

          it('parses unary minus before a binary operator', () => {
            expect(shape(parseExpression('-x * 2'))).toEqual(['*', ['-', 'x'], 2]);
          });

          it('parses chained calls above binary operators', () => {
            expect(shape(parseExpression('make(1)(2 + 3) * 4'))).toEqual([
              '*', ['call', ['call', 'make', [1]], [['+', 2, 3]]], 4,
            ]);
          });

          it('rejects missing delimiters and trailing tokens', () => {
            expect(throws('call(1, 2')).toBe(true);
            expect(throws('1 2')).toBe(true);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/parser.ts',
      code`
        import { tokenize, type Token } from './lexer';

        export type Expression =
          | { kind: 'number'; value: number; start: number; end: number }
          | { kind: 'identifier'; name: string; start: number; end: number }
          | { kind: 'unary'; operator: string; operand: Expression; start: number; end: number }
          | { kind: 'binary'; operator: string; left: Expression; right: Expression; start: number; end: number }
          | { kind: 'call'; callee: Expression; args: Expression[]; start: number; end: number };

        const BINDING_POWER: Record<string, number> = {
          '==': 1,
          '!=': 1,
          '<': 2,
          '<=': 2,
          '>': 2,
          '>=': 2,
          '+': 3,
          '-': 3,
          '*': 4,
          '/': 4,
        };

        export function parseExpression(source: string): Expression {
          const tokens = tokenize(source);
          let cursor = 0;

          function peek(): Token {
            return tokens[cursor];
          }

          function take(): Token {
            const token = tokens[cursor];
            cursor += 1;
            return token;
          }

          function expect(text: string): Token {
            const token = take();
            if (token.text !== text) throw new Error('expected ' + text + ' at ' + token.start);
            return token;
          }

          function parse(minBindingPower: number): Expression {
            const first = take();
            let left: Expression;

            if (first.kind === 'number') {
              left = { kind: 'number', value: Number(first.text), start: first.start, end: first.end };
            } else if (first.kind === 'identifier') {
              left = { kind: 'identifier', name: first.text, start: first.start, end: first.end };
            } else if (first.text === '-') {
              const operand = parse(5);
              left = { kind: 'unary', operator: '-', operand, start: first.start, end: operand.end };
            } else if (first.text === '(') {
              const inner = parse(0);
              const close = expect(')');
              left = { ...inner, start: first.start, end: close.end } as Expression;
            } else {
              throw new Error('expected expression at ' + first.start);
            }

            while (true) {
              if (peek().text === '(') {
                const callBindingPower = 6;
                if (callBindingPower < minBindingPower) break;
                take();
                const args: Expression[] = [];
                if (peek().text !== ')') {
                  while (true) {
                    args.push(parse(0));
                    if (peek().text !== ',') break;
                    take();
                  }
                }
                const close = expect(')');
                left = { kind: 'call', callee: left, args, start: left.start, end: close.end };
                continue;
              }

              const operator = peek().text;
              const leftBindingPower = BINDING_POWER[operator];
              if (leftBindingPower === undefined || leftBindingPower < minBindingPower) break;
              take();
              const right = parse(leftBindingPower + 1);
              left = {
                kind: 'binary',
                operator,
                left,
                right,
                start: left.start,
                end: right.end,
              };
            }
            return left;
          }

          const expression = parse(0);
          if (peek().kind !== 'eof') throw new Error('unexpected token ' + peek().text + ' at ' + peek().start);
          return expression;
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · Name resolution                                          */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'name-resolution',
  title: t('第 3 关 · 作用域、遮蔽与名字解析', 'Stage 3 · Scopes, shadowing and name resolution'),
  goal: t(
    [
      '解析器只知道源码里写了 `value`，不知道它指向哪一次声明。名字解析要把每个 use 绑定到唯一 declaration，后续类型检查和代码生成都只认 binding id。',
      '',
      '在 `src/resolver.ts` 实现 `resolve(program)`：',
      '',
      '- 每个 block 建立一层词法作用域；',
      '- 同一作用域重复声明产生 duplicate 诊断；',
      '- 内层声明可以遮蔽外层声明；',
      '- 使用发生在声明之前时按 unresolved 处理；',
      '- 每个有效声明获得稳定递增的 binding id；',
      '- 每个 use 记录绑定 id 和向外查找的 depth。',
      '',
      '不要把名字直接写回 AST 声明对象。binding id 才是稳定身份，名字只是用户写下的拼写。',
    ].join('\n'),
    [
      'The parser knows that source says `value`, but not which declaration it names. Resolution binds every',
      'use to one declaration. Type checking and code generation then work with binding ids, not spelling.',
      '',
      'Implement `resolve(program)` in `src/resolver.ts`:',
      '',
      '- Every block introduces a lexical scope;',
      '- Repeating a declaration in one scope produces a duplicate diagnostic;',
      '- An inner declaration may shadow an outer one;',
      '- A use before its declaration is unresolved;',
      '- Every valid declaration receives a stable increasing binding id;',
      '- Every use records its binding id and outward lookup depth.',
      '',
      'Do not use the declaration name as identity. A binding id remains stable while names are only source',
      'spelling and may be shadowed.',
    ].join('\n')
  ),
  checklist: [
    t('每个 use 绑定到唯一 declaration', 'Every use binds to one declaration'),
    t('内层遮蔽不会覆盖外层作用域表', 'Inner shadowing does not overwrite the outer scope'),
    t('同层重复声明产生诊断', 'Same-scope duplicates produce diagnostics'),
    t('先使用后声明不会被错误绑定', 'A use before declaration is not bound retroactively'),
  ],
  hints: [
    t('进入 block 时 push Map，离开时 pop。查找时从栈顶向外走。', 'Push a Map on block entry, pop it on exit, and resolve from the stack top outward.'),
    t('先处理 var initializer，再把声明加入当前 scope。', 'Resolve a variable initializer before adding its declaration to the current scope.'),
  ],
  pitfalls: [
    t('使用一张全局 name Map 会让内层遮蔽永久覆盖外层绑定。', 'One global name Map lets inner shadowing overwrite an outer binding permanently.'),
    t('预先收集 block 的全部声明会意外允许先使用后声明。', 'Collecting every declaration before walking a block accidentally permits use before declaration.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/resolver.ts',
      code`
        export type Statement =
          | { kind: 'var'; name: string; initializer?: Statement }
          | { kind: 'use'; name: string }
          | { kind: 'block'; statements: Statement[] };

        export interface ResolvedUse {
          name: string;
          bindingId: number;
          depth: number;
        }

        export interface Resolution {
          declarations: Array<{ name: string; bindingId: number }>;
          uses: ResolvedUse[];
          diagnostics: Array<{ kind: 'duplicate' | 'unresolved'; name: string }>;
        }

        export function resolve(program: Statement): Resolution {
          // TODO: walk lexical scopes in source order
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-3.spec.ts',
      code`
        import { resolve, type Statement } from '../src/resolver';

        const block = (statements: Statement[]): Statement => ({ kind: 'block', statements });

        describe('Stage 3 · Name resolution', () => {
          it('binds a use to the preceding declaration', () => {
            const result = resolve(block([{ kind: 'var', name: 'x' }, { kind: 'use', name: 'x' }]));
            expect(result.declarations).toEqual([{ name: 'x', bindingId: 1 }]);
            expect(result.uses).toEqual([{ name: 'x', bindingId: 1, depth: 0 }]);
            expect(result.diagnostics).toEqual([]);
          });

          it('resolves outward and records lexical depth', () => {
            const result = resolve(block([
              { kind: 'var', name: 'x' },
              block([block([{ kind: 'use', name: 'x' }])]),
            ]));
            expect(result.uses).toEqual([{ name: 'x', bindingId: 1, depth: 2 }]);
          });

          it('lets an inner declaration shadow an outer one', () => {
            const result = resolve(block([
              { kind: 'var', name: 'x' },
              block([{ kind: 'var', name: 'x' }, { kind: 'use', name: 'x' }]),
              { kind: 'use', name: 'x' },
            ]));
            expect(result.uses.map((use) => use.bindingId)).toEqual([2, 1]);
          });

          it('reports duplicates in one scope without replacing the first binding', () => {
            const result = resolve(block([
              { kind: 'var', name: 'x' },
              { kind: 'var', name: 'x' },
              { kind: 'use', name: 'x' },
            ]));
            expect(result.diagnostics).toEqual([{ kind: 'duplicate', name: 'x' }]);
            expect(result.uses[0].bindingId).toBe(1);
          });

          it('does not bind a use to a later declaration', () => {
            const result = resolve(block([{ kind: 'use', name: 'late' }, { kind: 'var', name: 'late' }]));
            expect(result.uses).toEqual([]);
            expect(result.diagnostics).toEqual([{ kind: 'unresolved', name: 'late' }]);
          });

          it('resolves an initializer before publishing its declaration', () => {
            const result = resolve(block([
              { kind: 'var', name: 'x' },
              block([{ kind: 'var', name: 'x', initializer: { kind: 'use', name: 'x' } }]),
            ]));
            expect(result.uses).toEqual([{ name: 'x', bindingId: 1, depth: 1 }]);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/resolver.ts',
      code`
        export type Statement =
          | { kind: 'var'; name: string; initializer?: Statement }
          | { kind: 'use'; name: string }
          | { kind: 'block'; statements: Statement[] };

        export interface ResolvedUse {
          name: string;
          bindingId: number;
          depth: number;
        }

        export interface Resolution {
          declarations: Array<{ name: string; bindingId: number }>;
          uses: ResolvedUse[];
          diagnostics: Array<{ kind: 'duplicate' | 'unresolved'; name: string }>;
        }

        export function resolve(program: Statement): Resolution {
          const scopes: Array<Map<string, number>> = [];
          const declarations: Array<{ name: string; bindingId: number }> = [];
          const uses: ResolvedUse[] = [];
          const diagnostics: Array<{ kind: 'duplicate' | 'unresolved'; name: string }> = [];
          let nextBindingId = 1;

          function find(name: string): { bindingId: number; depth: number } | null {
            for (let index = scopes.length - 1; index >= 0; index -= 1) {
              const bindingId = scopes[index].get(name);
              if (bindingId !== undefined) return { bindingId, depth: scopes.length - 1 - index };
            }
            return null;
          }

          function visit(statement: Statement): void {
            if (statement.kind === 'block') {
              scopes.push(new Map());
              statement.statements.forEach(visit);
              scopes.pop();
              return;
            }
            if (statement.kind === 'use') {
              const binding = find(statement.name);
              if (binding) uses.push({ name: statement.name, ...binding });
              else diagnostics.push({ kind: 'unresolved', name: statement.name });
              return;
            }

            if (statement.initializer) visit(statement.initializer);
            const scope = scopes[scopes.length - 1];
            if (!scope) throw new Error('declaration outside a block');
            if (scope.has(statement.name)) {
              diagnostics.push({ kind: 'duplicate', name: statement.name });
              return;
            }
            const bindingId = nextBindingId;
            nextBindingId += 1;
            scope.set(statement.name, bindingId);
            declarations.push({ name: statement.name, bindingId });
          }

          visit(program);
          return { declarations, uses, diagnostics };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · Type inference                                           */
/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'type-inference',
  title: t('第 4 关 · 约束生成与类型合一', 'Stage 4 · Constraint generation and type unification'),
  goal: t(
    [
      '类型推断不是从语法树上猜一个字符串。每个未知类型先拿到类型变量，表达式规则生成约束，再由 unify 把变量、基础类型和函数类型合到一起。',
      '',
      '在 `src/types.ts` 实现 `infer(expression)`：',
      '',
      '- 支持 number、boolean、lambda、call、`+`、`==` 和 if；',
      '- lambda 参数先使用新类型变量；',
      '- call 把 callee 约束成 parameter 到 result 的函数；',
      '- if 条件必须是 boolean，两个分支必须合一；',
      '- occurs check 拒绝无限递归类型；',
      '- 输出使用稳定的 `t0`、`t1` 名称。',
      '',
      '缺少 occurs check 时，`fn x => x(x)` 会让一个类型变量包含自己。渲染或继续合一时，它会无限递归。',
    ].join('\n'),
    [
      'Type inference is not guessing a string from syntax. Each unknown receives a type variable, expression',
      'rules produce constraints, and unification joins variables, primitive types and function types.',
      '',
      'Implement `infer(expression)` in `src/types.ts`:',
      '',
      '- Support number, boolean, lambda, call, `+`, `==` and if;',
      '- Give each lambda parameter a fresh type variable;',
      '- A call constrains its callee to a parameter-to-result function;',
      '- An if condition is boolean and both branches must unify;',
      '- An occurs check rejects infinite recursive types;',
      '- Render unknowns with stable names such as `t0` and `t1`.',
      '',
      'Without the occurs check, `fn x => x(x)` makes a type variable contain itself. Rendering or further',
      'unification then recurses forever.',
    ].join('\n')
  ),
  checklist: [
    t('lambda 参数使用新类型变量', 'Lambda parameters use fresh type variables'),
    t('函数调用统一参数和返回类型', 'Calls unify parameter and result types'),
    t('if 两个分支必须得到同一类型', 'Both if branches must have one type'),
    t('occurs check 拒绝无限类型', 'The occurs check rejects infinite types'),
  ],
  hints: [
    t('type variable 可以带一个可选 instance，prune 负责追到最终类型。', 'A type variable may hold an optional instance, with prune following it to the final type.'),
    t('unify 两个函数类型时分别统一 parameter 和 result。', 'Unifying functions means unifying both parameter and result.'),
  ],
  pitfalls: [
    t('按变量名缓存 lambda 参数类型，会让不同作用域里同名参数错误共享类型。', 'Caching lambda parameter types by name makes same-named parameters in separate scopes share a type.'),
    t('if 只检查条件，不统一分支，会把一个表达式推断成运行时才知道的联合状态。', 'Checking only the condition of if leaves a result whose type depends on runtime control flow.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/types.ts',
      code`
        export type Expression =
          | { kind: 'number'; value: number }
          | { kind: 'boolean'; value: boolean }
          | { kind: 'variable'; name: string }
          | { kind: 'lambda'; parameter: string; body: Expression }
          | { kind: 'call'; callee: Expression; argument: Expression }
          | { kind: 'binary'; operator: '+' | '=='; left: Expression; right: Expression }
          | { kind: 'if'; condition: Expression; then: Expression; else: Expression };

        export function infer(expression: Expression): string {
          // TODO: generate constraints, unify them and render the resulting type
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-4.spec.ts',
      code`
        import { infer, type Expression } from '../src/types';

        const variable = (name: string): Expression => ({ kind: 'variable', name });
        const num = (value: number): Expression => ({ kind: 'number', value });

        function throws(expression: Expression): boolean {
          try { infer(expression); return false; } catch (error) { return true; }
        }

        describe('Stage 4 · Type inference', () => {
          it('infers primitive arithmetic', () => {
            expect(infer({ kind: 'binary', operator: '+', left: num(1), right: num(2) })).toBe('number');
          });

          it('keeps the input and output of identity connected', () => {
            expect(infer({ kind: 'lambda', parameter: 'x', body: variable('x') })).toBe('(t0) -> t0');
          });

          it('infers a call through a lambda', () => {
            const identity: Expression = { kind: 'lambda', parameter: 'x', body: variable('x') };
            expect(infer({ kind: 'call', callee: identity, argument: num(7) })).toBe('number');
          });

          it('infers comparison as boolean after unifying operands', () => {
            const expression: Expression = {
              kind: 'binary', operator: '==', left: { kind: 'boolean', value: true }, right: { kind: 'boolean', value: false },
            };
            expect(infer(expression)).toBe('boolean');
          });

          it('requires a boolean condition and matching branches', () => {
            expect(throws({ kind: 'if', condition: num(1), then: num(2), else: num(3) })).toBe(true);
            expect(throws({
              kind: 'if',
              condition: { kind: 'boolean', value: true },
              then: num(2),
              else: { kind: 'boolean', value: false },
            })).toBe(true);
          });

          it('rejects an infinite self-application type', () => {
            const selfApplication: Expression = {
              kind: 'lambda',
              parameter: 'x',
              body: { kind: 'call', callee: variable('x'), argument: variable('x') },
            };
            expect(throws(selfApplication)).toBe(true);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/types.ts',
      code`
        export type Expression =
          | { kind: 'number'; value: number }
          | { kind: 'boolean'; value: boolean }
          | { kind: 'variable'; name: string }
          | { kind: 'lambda'; parameter: string; body: Expression }
          | { kind: 'call'; callee: Expression; argument: Expression }
          | { kind: 'binary'; operator: '+' | '=='; left: Expression; right: Expression }
          | { kind: 'if'; condition: Expression; then: Expression; else: Expression };

        type Type =
          | { kind: 'number' }
          | { kind: 'boolean' }
          | { kind: 'function'; parameter: Type; result: Type }
          | { kind: 'variable'; id: number; instance?: Type };

        export function infer(expression: Expression): string {
          let nextTypeId = 0;

          function fresh(): Type {
            const type: Type = { kind: 'variable', id: nextTypeId };
            nextTypeId += 1;
            return type;
          }

          function prune(type: Type): Type {
            if (type.kind === 'variable' && type.instance) {
              type.instance = prune(type.instance);
              return type.instance;
            }
            return type;
          }

          function occurs(variable: Extract<Type, { kind: 'variable' }>, type: Type): boolean {
            const resolved = prune(type);
            if (resolved === variable) return true;
            if (resolved.kind === 'function') {
              return occurs(variable, resolved.parameter) || occurs(variable, resolved.result);
            }
            return false;
          }

          function unify(left: Type, right: Type): void {
            const a = prune(left);
            const b = prune(right);
            if (a === b) return;
            if (a.kind === 'variable') {
              if (occurs(a, b)) throw new Error('infinite type');
              a.instance = b;
              return;
            }
            if (b.kind === 'variable') {
              unify(b, a);
              return;
            }
            if (a.kind === 'function' && b.kind === 'function') {
              unify(a.parameter, b.parameter);
              unify(a.result, b.result);
              return;
            }
            if (a.kind !== b.kind) throw new Error('type mismatch');
          }

          function visit(node: Expression, environment: Map<string, Type>): Type {
            if (node.kind === 'number') return { kind: 'number' };
            if (node.kind === 'boolean') return { kind: 'boolean' };
            if (node.kind === 'variable') {
              const found = environment.get(node.name);
              if (!found) throw new Error('unbound variable ' + node.name);
              return found;
            }
            if (node.kind === 'lambda') {
              const parameter = fresh();
              const child = new Map(environment);
              child.set(node.parameter, parameter);
              return { kind: 'function', parameter, result: visit(node.body, child) };
            }
            if (node.kind === 'call') {
              const callee = visit(node.callee, environment);
              const argument = visit(node.argument, environment);
              const result = fresh();
              unify(callee, { kind: 'function', parameter: argument, result });
              return result;
            }
            if (node.kind === 'binary') {
              const left = visit(node.left, environment);
              const right = visit(node.right, environment);
              if (node.operator === '+') {
                unify(left, { kind: 'number' });
                unify(right, { kind: 'number' });
                return { kind: 'number' };
              }
              unify(left, right);
              return { kind: 'boolean' };
            }
            const condition = visit(node.condition, environment);
            unify(condition, { kind: 'boolean' });
            const thenType = visit(node.then, environment);
            const elseType = visit(node.else, environment);
            unify(thenType, elseType);
            return thenType;
          }

          const names = new Map<number, string>();
          function render(type: Type): string {
            const resolved = prune(type);
            if (resolved.kind === 'number' || resolved.kind === 'boolean') return resolved.kind;
            if (resolved.kind === 'function') return '(' + render(resolved.parameter) + ') -> ' + render(resolved.result);
            let name = names.get(resolved.id);
            if (!name) {
              name = 't' + names.size;
              names.set(resolved.id, name);
            }
            return name;
          }

          return render(visit(expression, new Map()));
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 5 关 · SSA lowering                                             */
/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'ssa-lowering',
  title: t('第 5 关 · 从 AST 降到 SSA 中间表示', 'Stage 5 · Lowering AST into SSA IR'),
  goal: t(
    [
      'AST 适合表达源码结构，不适合做数据流优化。中端需要显式基本块、控制流边和单赋值 value，if 的两个结果在汇合点通过 phi 合并。',
      '',
      '在 `src/ir.ts` 实现 `lowerFunction(functionAst)`：',
      '',
      '- 参数映射到稳定的 `%arg0`、`%arg1`；',
      '- 常量和二元操作各产生一个新的 SSA value；',
      '- if 建立 then、else 和 join 三个块；',
      '- 分支块以 jump 进入 join，join 使用 phi 合并值；',
      '- 每个 block 恰好有一个 terminator；',
      '- 未绑定变量立即报错。',
      '',
      'phi 的输入必须带来源 block。只保存两个 value，后续删除或重排前驱时就不知道每个值来自哪条控制流边。',
    ].join('\n'),
    [
      'An AST represents source structure well but is awkward for data-flow optimisation. The middle end',
      'needs explicit basic blocks, control-flow edges and single-assignment values. A phi joins results from',
      'the two sides of an if.',
      '',
      'Implement `lowerFunction(functionAst)` in `src/ir.ts`:',
      '',
      '- Map parameters to stable values `%arg0`, `%arg1`;',
      '- Constants and binary operations each define a fresh SSA value;',
      '- An if creates then, else and join blocks;',
      '- Branch blocks jump to join, where a phi merges their values;',
      '- Every block has exactly one terminator;',
      '- Report an unbound variable immediately.',
      '',
      'Phi inputs must include their source block. Keeping only two values loses the edge association after',
      'a later pass deletes or reorders predecessors.',
    ].join('\n')
  ),
  checklist: [
    t('每条产生值的指令只定义一次', 'Each value-producing instruction defines once'),
    t('if 创建显式控制流块', 'An if creates explicit control-flow blocks'),
    t('phi 输入保留前驱 block id', 'Phi inputs retain predecessor block ids'),
    t('所有基本块都有 terminator', 'Every basic block has a terminator'),
  ],
  hints: [
    t('维护 current block、nextValue 和 nextBlock 三个构建状态。', 'Track the current block, next value and next block while lowering.'),
    t('lower(if) 返回 join 块中 phi 指令的结果 value。', '`lower(if)` returns the phi result from the join block.'),
  ],
  pitfalls: [
    t('把 if 两个分支的指令都放进同一个 block，会让它们在运行时无条件执行。', 'Putting both sides of an if in one block makes both execute unconditionally.'),
    t('value id 按变量名生成会在遮蔽和重复表达式下产生多次定义。', 'Deriving value ids from names creates multiple definitions under shadowing and repeated expressions.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/ir.ts',
      code`
        export type AstExpression =
          | { kind: 'number'; value: number }
          | { kind: 'variable'; name: string }
          | { kind: 'binary'; operator: '+' | '-' | '*' | '=='; left: AstExpression; right: AstExpression }
          | { kind: 'if'; condition: AstExpression; then: AstExpression; else: AstExpression };

        export interface FunctionAst { name: string; params: string[]; body: AstExpression }
        export interface IrInstruction { id: string; op: 'const' | 'add' | 'sub' | 'mul' | 'eq' | 'phi'; args: Array<string | number> }
        export type Terminator =
          | { kind: 'return'; value: string }
          | { kind: 'jump'; target: string }
          | { kind: 'branch'; condition: string; then: string; else: string };
        export interface IrBlock { id: string; instructions: IrInstruction[]; terminator: Terminator }
        export interface IrFunction { name: string; params: Record<string, string>; entry: string; blocks: IrBlock[] }

        export function lowerFunction(input: FunctionAst): IrFunction {
          // TODO: create SSA values, basic blocks, terminators and phi inputs
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-5.spec.ts',
      code`
        import { lowerFunction, type FunctionAst } from '../src/ir';

        describe('Stage 5 · SSA lowering', () => {
          it('maps parameters and emits straight-line SSA values', () => {
            const input: FunctionAst = {
              name: 'add', params: ['x'], body: { kind: 'binary', operator: '+', left: { kind: 'variable', name: 'x' }, right: { kind: 'number', value: 1 } },
            };
            const output = lowerFunction(input);
            expect(output.params).toEqual({ x: '%arg0' });
            expect(output.blocks[0].instructions).toEqual([
              { id: '%0', op: 'const', args: [1] },
              { id: '%1', op: 'add', args: ['%arg0', '%0'] },
            ]);
            expect(output.blocks[0].terminator).toEqual({ kind: 'return', value: '%1' });
          });

          it('creates branch and join blocks for if', () => {
            const output = lowerFunction({
              name: 'choose', params: ['condition'], body: {
                kind: 'if', condition: { kind: 'variable', name: 'condition' },
                then: { kind: 'number', value: 1 }, else: { kind: 'number', value: 2 },
              },
            });
            expect(output.blocks.map((block) => block.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
            expect(output.blocks[0].terminator).toEqual({ kind: 'branch', condition: '%arg0', then: 'b1', else: 'b2' });
            expect(output.blocks[1].terminator).toEqual({ kind: 'jump', target: 'b3' });
            expect(output.blocks[2].terminator).toEqual({ kind: 'jump', target: 'b3' });
            expect(output.blocks[3].instructions[0]).toEqual({ id: '%2', op: 'phi', args: ['b1', '%0', 'b2', '%1'] });
            expect(output.blocks[3].terminator).toEqual({ kind: 'return', value: '%2' });
          });

          it('assigns every instruction a unique value id', () => {
            const output = lowerFunction({
              name: 'math', params: [], body: {
                kind: 'binary', operator: '*',
                left: { kind: 'number', value: 2 },
                right: { kind: 'binary', operator: '-', left: { kind: 'number', value: 5 }, right: { kind: 'number', value: 1 } },
              },
            });
            const ids = output.blocks.flatMap((block) => block.instructions.map((instruction) => instruction.id));
            expect(new Set(ids).size).toBe(ids.length);
          });

          it('gives every block exactly one terminator', () => {
            const output = lowerFunction({ name: 'one', params: [], body: { kind: 'number', value: 1 } });
            expect(output.blocks.every((block) => Boolean(block.terminator))).toBe(true);
          });

          it('rejects an unbound variable', () => {
            let message = '';
            try { lowerFunction({ name: 'bad', params: [], body: { kind: 'variable', name: 'missing' } }); }
            catch (error) { message = (error as Error).message; }
            expect(message).toBe('unbound variable missing');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/ir.ts',
      code`
        export type AstExpression =
          | { kind: 'number'; value: number }
          | { kind: 'variable'; name: string }
          | { kind: 'binary'; operator: '+' | '-' | '*' | '=='; left: AstExpression; right: AstExpression }
          | { kind: 'if'; condition: AstExpression; then: AstExpression; else: AstExpression };

        export interface FunctionAst { name: string; params: string[]; body: AstExpression }
        export interface IrInstruction { id: string; op: 'const' | 'add' | 'sub' | 'mul' | 'eq' | 'phi'; args: Array<string | number> }
        export type Terminator =
          | { kind: 'return'; value: string }
          | { kind: 'jump'; target: string }
          | { kind: 'branch'; condition: string; then: string; else: string };
        export interface IrBlock { id: string; instructions: IrInstruction[]; terminator: Terminator }
        export interface IrFunction { name: string; params: Record<string, string>; entry: string; blocks: IrBlock[] }

        export function lowerFunction(input: FunctionAst): IrFunction {
          let nextValue = 0;
          let nextBlock = 1;
          const params: Record<string, string> = {};
          input.params.forEach((name, index) => { params[name] = '%arg' + index; });
          const blocks: Array<{ id: string; instructions: IrInstruction[]; terminator?: Terminator }> = [
            { id: 'b0', instructions: [] },
          ];
          let current = blocks[0];

          function value(): string {
            const id = '%' + nextValue;
            nextValue += 1;
            return id;
          }

          function block(): { id: string; instructions: IrInstruction[]; terminator?: Terminator } {
            const created = { id: 'b' + nextBlock, instructions: [] as IrInstruction[] };
            nextBlock += 1;
            blocks.push(created);
            return created;
          }

          function emit(op: IrInstruction['op'], args: Array<string | number>): string {
            const id = value();
            current.instructions.push({ id, op, args });
            return id;
          }

          function lower(expression: AstExpression): string {
            if (expression.kind === 'number') return emit('const', [expression.value]);
            if (expression.kind === 'variable') {
              const found = params[expression.name];
              if (!found) throw new Error('unbound variable ' + expression.name);
              return found;
            }
            if (expression.kind === 'binary') {
              const left = lower(expression.left);
              const right = lower(expression.right);
              const op = ({ '+': 'add', '-': 'sub', '*': 'mul', '==': 'eq' } as const)[expression.operator];
              return emit(op, [left, right]);
            }

            const condition = lower(expression.condition);
            const thenBlock = block();
            const elseBlock = block();
            const joinBlock = block();
            current.terminator = { kind: 'branch', condition, then: thenBlock.id, else: elseBlock.id };

            current = thenBlock;
            const thenValue = lower(expression.then);
            current.terminator = { kind: 'jump', target: joinBlock.id };

            current = elseBlock;
            const elseValue = lower(expression.else);
            current.terminator = { kind: 'jump', target: joinBlock.id };

            current = joinBlock;
            return emit('phi', [thenBlock.id, thenValue, elseBlock.id, elseValue]);
          }

          const result = lower(input.body);
          current.terminator = { kind: 'return', value: result };
          return {
            name: input.name,
            params,
            entry: 'b0',
            blocks: blocks.map((item) => {
              if (!item.terminator) throw new Error('unterminated block ' + item.id);
              return { id: item.id, instructions: item.instructions, terminator: item.terminator };
            }),
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 6 关 · CFG and dominators                                       */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'cfg-dominators',
  title: t('第 6 关 · 控制流图与支配关系', 'Stage 6 · Control-flow graphs and dominators'),
  goal: t(
    [
      '循环优化、phi 放置和代码移动都要回答同一个问题：某个 block 是否必然先于另一个 block 执行。支配关系把这个问题变成可计算的数据流。',
      '',
      '在 `src/cfg.ts` 实现 `analyzeCfg(entry, blocks)`：',
      '',
      '- 从 entry 计算 reachable blocks，忽略不可达块；',
      '- 为每个可达块建立 predecessor 列表；',
      '- 用迭代数据流求 dominator 集合；',
      '- 计算 entry 之外每个 block 的 immediate dominator；',
      '- 输出顺序按输入 block 顺序保持稳定；',
      '- 缺失后继或 entry 时明确报错。',
      '',
      '不可达块不能混进 dominator 的全集。否则一个永远不会执行的块也会参与交集，结果看起来稳定，却没有控制流意义。',
    ].join('\n'),
    [
      'Loop optimisation, phi placement and code motion ask the same question: must one block execute before',
      'another? Dominance turns that question into computable data flow.',
      '',
      'Implement `analyzeCfg(entry, blocks)` in `src/cfg.ts`:',
      '',
      '- Compute reachable blocks from entry and ignore unreachable ones;',
      '- Build predecessor lists for each reachable block;',
      '- Solve dominator sets with iterative data flow;',
      '- Compute the immediate dominator of every block except entry;',
      '- Preserve input block order in the output;',
      '- Report a missing entry or successor explicitly.',
      '',
      'Unreachable blocks must not enter the universal dominator set. A block that never executes has no',
      'meaningful place in control-flow intersections.',
    ].join('\n')
  ),
  checklist: [
    t('只分析从 entry 可达的 block', 'Only blocks reachable from entry are analysed'),
    t('前驱表与后继边一致', 'Predecessors agree with successor edges'),
    t('支配集合迭代到不再变化', 'Dominator sets iterate to a fixed point'),
    t('immediate dominator 是最近的严格支配者', 'The immediate dominator is the nearest strict dominator'),
  ],
  hints: [
    t('entry 的 dominator 只有自己，其他可达块初始为全部可达块。', 'Entry starts dominated only by itself; every other reachable block starts with all reachable blocks.'),
    t('一个块的新集合是所有前驱集合的交集，再加上它自己。', 'A block receives the intersection of predecessor sets plus itself.'),
  ],
  pitfalls: [
    t('只迭代一轮在带回边的 CFG 上不会收敛到正确结果。', 'One iteration does not reach the correct result on a CFG with back edges.'),
    t('把任意严格支配者当作 idom，会在三层以上的路径上选到 entry。', 'Choosing any strict dominator as idom selects entry on paths deeper than two blocks.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/cfg.ts',
      code`
        export interface CfgBlock { id: string; successors: string[] }
        export interface CfgAnalysis {
          reachable: string[];
          predecessors: Record<string, string[]>;
          dominators: Record<string, string[]>;
          immediateDominators: Record<string, string | null>;
        }

        export function analyzeCfg(entry: string, blocks: CfgBlock[]): CfgAnalysis {
          // TODO: validate edges, find reachability and solve dominance to a fixed point
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-6.spec.ts',
      code`
        import { analyzeCfg } from '../src/cfg';

        describe('Stage 6 · CFG and dominators', () => {
          it('builds predecessors for a diamond', () => {
            const analysis = analyzeCfg('entry', [
              { id: 'entry', successors: ['left', 'right'] },
              { id: 'left', successors: ['join'] },
              { id: 'right', successors: ['join'] },
              { id: 'join', successors: [] },
            ]);
            expect(analysis.predecessors).toEqual({ entry: [], left: ['entry'], right: ['entry'], join: ['left', 'right'] });
          });

          it('computes dominators and the nearest immediate dominator', () => {
            const analysis = analyzeCfg('entry', [
              { id: 'entry', successors: ['a'] },
              { id: 'a', successors: ['b'] },
              { id: 'b', successors: [] },
            ]);
            expect(analysis.dominators.b).toEqual(['entry', 'a', 'b']);
            expect(analysis.immediateDominators).toEqual({ entry: null, a: 'entry', b: 'a' });
          });

          it('finds the diamond join dominated only by entry and itself', () => {
            const analysis = analyzeCfg('entry', [
              { id: 'entry', successors: ['left', 'right'] },
              { id: 'left', successors: ['join'] },
              { id: 'right', successors: ['join'] },
              { id: 'join', successors: [] },
            ]);
            expect(analysis.dominators.join).toEqual(['entry', 'join']);
            expect(analysis.immediateDominators.join).toBe('entry');
          });

          it('converges across a loop back edge', () => {
            const analysis = analyzeCfg('entry', [
              { id: 'entry', successors: ['head'] },
              { id: 'head', successors: ['body', 'exit'] },
              { id: 'body', successors: ['head'] },
              { id: 'exit', successors: [] },
            ]);
            expect(analysis.dominators.body).toEqual(['entry', 'head', 'body']);
            expect(analysis.immediateDominators.exit).toBe('head');
          });

          it('excludes unreachable blocks', () => {
            const analysis = analyzeCfg('entry', [
              { id: 'entry', successors: ['exit'] },
              { id: 'dead', successors: [] },
              { id: 'exit', successors: [] },
            ]);
            expect(analysis.reachable).toEqual(['entry', 'exit']);
            expect(analysis.dominators.dead).toBe(undefined);
          });

          it('rejects an edge to a missing block', () => {
            let message = '';
            try { analyzeCfg('entry', [{ id: 'entry', successors: ['missing'] }]); }
            catch (error) { message = (error as Error).message; }
            expect(message).toBe('missing successor missing');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/cfg.ts',
      code`
        export interface CfgBlock { id: string; successors: string[] }
        export interface CfgAnalysis {
          reachable: string[];
          predecessors: Record<string, string[]>;
          dominators: Record<string, string[]>;
          immediateDominators: Record<string, string | null>;
        }

        export function analyzeCfg(entry: string, blocks: CfgBlock[]): CfgAnalysis {
          const byId = new Map(blocks.map((block) => [block.id, block]));
          if (!byId.has(entry)) throw new Error('missing entry ' + entry);
          for (const block of blocks) {
            for (const successor of block.successors) {
              if (!byId.has(successor)) throw new Error('missing successor ' + successor);
            }
          }

          const seen = new Set<string>();
          function visit(id: string): void {
            if (seen.has(id)) return;
            seen.add(id);
            (byId.get(id) as CfgBlock).successors.forEach(visit);
          }
          visit(entry);
          const reachable = blocks.filter((block) => seen.has(block.id)).map((block) => block.id);
          const order = new Map(reachable.map((id, index) => [id, index]));
          const predecessors: Record<string, string[]> = {};
          reachable.forEach((id) => { predecessors[id] = []; });
          for (const id of reachable) {
            for (const successor of (byId.get(id) as CfgBlock).successors) {
              if (seen.has(successor)) predecessors[successor].push(id);
            }
          }

          const all = new Set(reachable);
          const dom = new Map<string, Set<string>>();
          reachable.forEach((id) => dom.set(id, id === entry ? new Set([entry]) : new Set(all)));
          let changed = true;
          while (changed) {
            changed = false;
            for (const id of reachable) {
              if (id === entry) continue;
              const incoming = predecessors[id];
              let next = incoming.length ? new Set(dom.get(incoming[0])) : new Set<string>();
              for (const predecessor of incoming.slice(1)) {
                const predecessorSet = dom.get(predecessor) as Set<string>;
                next = new Set(Array.from(next).filter((item) => predecessorSet.has(item)));
              }
              next.add(id);
              const previous = dom.get(id) as Set<string>;
              if (next.size !== previous.size || Array.from(next).some((item) => !previous.has(item))) {
                dom.set(id, next);
                changed = true;
              }
            }
          }

          const dominators: Record<string, string[]> = {};
          const immediateDominators: Record<string, string | null> = {};
          for (const id of reachable) {
            const sorted = Array.from(dom.get(id) as Set<string>).sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
            dominators[id] = sorted;
            if (id === entry) immediateDominators[id] = null;
            else {
              const strict = sorted.filter((item) => item !== id);
              immediateDominators[id] = strict.find((candidate) =>
                strict.every((other) => other === candidate || !(dom.get(other) as Set<string>).has(candidate))
              ) || null;
            }
          }

          return { reachable, predecessors, dominators, immediateDominators };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · Optimisation                                             */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'optimization-pipeline',
  title: t('第 7 关 · 常量传播与死代码删除', 'Stage 7 · Constant propagation and dead-code elimination'),
  goal: t(
    [
      '优化器不能只改一条指令。常量折叠产生的新常量要继续向后传播，随后 DCE 再从返回值和副作用反向标记真正活跃的指令。',
      '',
      '在 `src/optimizer.ts` 实现 `optimize(functionIr)`：',
      '',
      '- 对 const、copy、add、sub 和 mul 做前向常量传播；',
      '- 两个操作数都是常量时折叠成 const；',
      '- 返回值本身可替换成常量；',
      '- 从 return 和 call 副作用反向保留依赖；',
      '- 删除其余无用纯指令；',
      '- 不修改输入 IR。',
      '',
      'call 即使返回值没人使用也不能删除。DCE 判断的是可观察行为，不是结果变量有没有读者。',
    ].join('\n'),
    [
      'An optimiser cannot rewrite one instruction in isolation. A folded constant must propagate forward,',
      'then DCE walks backward from the return value and side effects to mark the instructions that remain live.',
      '',
      'Implement `optimize(functionIr)` in `src/optimizer.ts`:',
      '',
      '- Propagate constants through const, copy, add, sub and mul;',
      '- Fold arithmetic when both operands are constant;',
      '- Replace the return value itself with a constant when possible;',
      '- Mark dependencies backward from return and side-effecting calls;',
      '- Delete every other unused pure instruction;',
      '- Leave the input IR unchanged.',
      '',
      'A call cannot be deleted merely because nobody reads its result. DCE preserves observable behaviour,',
      'not variables with consumers.',
    ].join('\n')
  ),
  checklist: [
    t('常量沿 SSA use 向后传播', 'Constants propagate through SSA uses'),
    t('算术常量在编译期折叠', 'Constant arithmetic folds at compile time'),
    t('DCE 从 return 和副作用反向标记', 'DCE marks backward from return and side effects'),
    t('优化过程不修改输入 IR', 'Optimisation does not mutate its input IR'),
  ],
  hints: [
    t('前向 pass 保存 `Map<value, number>`，重写每条指令的 args。', 'The forward pass keeps `Map<value, number>` and rewrites instruction args.'),
    t('DCE 反向遍历，只有 live result 或 call 才保留并继续标记参数。', 'DCE walks backward, retaining a live result or a call and then marking its arguments.'),
  ],
  pitfalls: [
    t('只折叠原本就是常量的相邻指令，会漏掉 copy 和多层算术传播。', 'Folding only adjacent literal constants misses copies and multi-step arithmetic propagation.'),
    t('按 result 是否使用删除 call 会改变程序可观察行为。', 'Deleting a call because its result is unused changes observable behaviour.'),
  ],
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/optimizer.ts',
      code`
        export type Value = string | number;
        export interface Instruction {
          id: string;
          op: 'const' | 'copy' | 'add' | 'sub' | 'mul' | 'call';
          args: Value[];
        }
        export interface FunctionIr { instructions: Instruction[]; returnValue: Value }

        export function optimize(input: FunctionIr): FunctionIr {
          // TODO: propagate constants, fold arithmetic and remove dead pure instructions
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-7.spec.ts',
      code`
        import { optimize, type FunctionIr } from '../src/optimizer';
        import { count } from '@lab/metrics';

        describe('Stage 7 · Optimisation pipeline', () => {
          it('folds and propagates through several SSA values', () => {
            const output = optimize({
              instructions: [
                { id: '%0', op: 'const', args: [2] },
                { id: '%1', op: 'copy', args: ['%0'] },
                { id: '%2', op: 'const', args: [3] },
                { id: '%3', op: 'add', args: ['%1', '%2'] },
                { id: '%4', op: 'mul', args: ['%3', 4] },
              ],
              returnValue: '%4',
            });
            expect(output).toEqual({ instructions: [], returnValue: 20 });
          });

          it('removes an unused pure calculation', () => {
            const output = optimize({
              instructions: [
                { id: '%0', op: 'add', args: ['%arg0', 1] },
                { id: '%1', op: 'mul', args: ['%arg0', 9] },
              ],
              returnValue: '%0',
            });
            expect(output.instructions).toEqual([{ id: '%0', op: 'add', args: ['%arg0', 1] }]);
          });

          it('keeps calls and the values they depend on', () => {
            const output = optimize({
              instructions: [
                { id: '%0', op: 'add', args: ['%arg0', 1] },
                { id: '%1', op: 'call', args: ['print', '%0'] },
              ],
              returnValue: 0,
            });
            expect(output.instructions).toEqual([
              { id: '%0', op: 'add', args: ['%arg0', 1] },
              { id: '%1', op: 'call', args: ['print', '%0'] },
            ]);
          });

          it('does not treat call arguments as constant definitions', () => {
            const output = optimize({
              instructions: [{ id: '%0', op: 'call', args: ['random'] }],
              returnValue: '%0',
            });
            expect(output).toEqual({ instructions: [{ id: '%0', op: 'call', args: ['random'] }], returnValue: '%0' });
          });

          it('does not mutate the input [gate:remaining]', () => {
            const input: FunctionIr = {
              instructions: [
                { id: '%0', op: 'const', args: [1] },
                { id: '%1', op: 'add', args: ['%0', 2] },
              ],
              returnValue: '%1',
            };
            const snapshot = JSON.stringify(input);
            const output = optimize(input);
            count('optimizedInstructions', output.instructions.length);
            expect(JSON.stringify(input)).toBe(snapshot);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.optimizedInstructions',
      op: 'eq',
      value: 0,
      unit: 'instructions',
      zh: '完整常量表达式优化后不应保留运行时指令',
      en: 'A fully constant expression should leave no runtime instructions',
      dimension: 'latency',
      scope: 'gate:remaining',
    }),
  ],
  referenceFiles: [
    file(
      'src/optimizer.ts',
      code`
        export type Value = string | number;
        export interface Instruction {
          id: string;
          op: 'const' | 'copy' | 'add' | 'sub' | 'mul' | 'call';
          args: Value[];
        }
        export interface FunctionIr { instructions: Instruction[]; returnValue: Value }

        export function optimize(input: FunctionIr): FunctionIr {
          const constants = new Map<string, number>();

          function resolve(value: Value): Value {
            return typeof value === 'string' && constants.has(value) ? constants.get(value) as number : value;
          }

          const rewritten: Instruction[] = input.instructions.map((instruction) => {
            const args = instruction.args.map(resolve);
            let next: Instruction = { id: instruction.id, op: instruction.op, args };
            if (instruction.op === 'const') {
              constants.set(instruction.id, Number(args[0]));
            } else if (instruction.op === 'copy' && typeof args[0] === 'number') {
              next = { id: instruction.id, op: 'const', args: [args[0]] };
              constants.set(instruction.id, args[0]);
            } else if (
              (instruction.op === 'add' || instruction.op === 'sub' || instruction.op === 'mul') &&
              typeof args[0] === 'number' && typeof args[1] === 'number'
            ) {
              const value = instruction.op === 'add'
                ? args[0] + args[1]
                : instruction.op === 'sub'
                  ? args[0] - args[1]
                  : args[0] * args[1];
              next = { id: instruction.id, op: 'const', args: [value] };
              constants.set(instruction.id, value);
            }
            return next;
          });

          const returnValue = resolve(input.returnValue);
          const live = new Set<string>();
          if (typeof returnValue === 'string') live.add(returnValue);
          const kept: Instruction[] = [];
          for (let index = rewritten.length - 1; index >= 0; index -= 1) {
            const instruction = rewritten[index];
            if (instruction.op === 'call' || live.has(instruction.id)) {
              kept.push(instruction);
              instruction.args.forEach((argument) => {
                if (typeof argument === 'string' && argument.startsWith('%')) live.add(argument);
              });
            }
          }
          kept.reverse();
          return { instructions: kept, returnValue };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · Register allocation                                      */
/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'linear-scan-registers',
  title: t('第 8 关 · 线性扫描寄存器分配', 'Stage 8 · Linear-scan register allocation'),
  goal: t(
    [
      'SSA value 数量远多于机器寄存器。线性扫描把每个 value 的活跃区间按起点排序，过期区间归还寄存器，压力过高时选择 spill。',
      '',
      '在 `src/registers.ts` 实现 `allocateLinearScan(intervals, registers)`：',
      '',
      '- 不重叠的区间复用同一寄存器；',
      '- active 区间按结束位置维护；',
      '- 没有空闲寄存器时，比较当前区间和 active 中结束最晚的区间；',
      '- 结束更晚的一方 spill 到稳定的 `stack[n]`；',
      '- 输入顺序不影响结果，输入对象不被修改；',
      '- 重复 value 和非法区间明确报错。',
      '',
      'spill 不是简单地把当前 value 放到栈上。若 active 中有一个长区间，而当前区间很短，spill 长区间通常能让寄存器更快重新可用。',
    ].join('\n'),
    [
      'There are far more SSA values than machine registers. Linear scan orders live intervals by start,',
      'returns registers when intervals expire, and chooses a spill when pressure is too high.',
      '',
      'Implement `allocateLinearScan(intervals, registers)` in `src/registers.ts`:',
      '',
      '- Non-overlapping intervals reuse a register;',
      '- Keep active intervals ordered by end position;',
      '- With no free register, compare the current interval with the active interval ending last;',
      '- Spill the later-ending interval to a stable `stack[n]` location;',
      '- Input order does not affect the result and input objects remain unchanged;',
      '- Report duplicate values and invalid intervals.',
      '',
      'Spilling is not always putting the current value on the stack. If an active interval is long and the',
      'current one is short, spilling the long interval makes its register available sooner.',
    ].join('\n')
  ),
  checklist: [
    t('过期区间及时归还寄存器', 'Expired intervals return their registers promptly'),
    t('不重叠 value 能复用寄存器', 'Non-overlapping values reuse registers'),
    t('spill 选择比较活跃区间终点', 'Spill choice compares active interval ends'),
    t('stack slot 编号稳定且无重复', 'Stack slot numbers are stable and unique'),
  ],
  hints: [
    t('保存 active 项时同时带 interval 和 register。', 'Keep both the interval and register in each active entry.'),
    t('空闲寄存器按调用方给定顺序取用，归还后也按这个顺序排序。', 'Allocate free registers in caller order and restore that order after expiration.'),
  ],
  pitfalls: [
    t('只 spill 当前区间会保留一个很长的 active 区间，让后面更多短区间继续 spill。', 'Always spilling the current interval preserves a long active interval and forces more short intervals to spill.'),
    t('以数组输入顺序代替 start 排序，会让同一组区间产生不稳定结果。', 'Using input order instead of start order makes one interval set allocate inconsistently.'),
  ],
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/registers.ts',
      code`
        export interface LiveInterval { value: string; start: number; end: number }
        export interface Allocation {
          locations: Record<string, string>;
          spills: number;
        }

        export function allocateLinearScan(intervals: LiveInterval[], registers: string[]): Allocation {
          // TODO: expire active intervals, allocate registers and choose stable spills
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-8.spec.ts',
      code`
        import { allocateLinearScan } from '../src/registers';
        import { count } from '@lab/metrics';

        function errorOf(run: () => void): string {
          try { run(); return ''; } catch (error) { return (error as Error).message; }
        }

        describe('Stage 8 · Linear-scan register allocation', () => {
          it('reuses a register after an interval expires', () => {
            const result = allocateLinearScan([
              { value: 'a', start: 0, end: 2 },
              { value: 'b', start: 3, end: 5 },
            ], ['t0']);
            expect(result).toEqual({ locations: { a: 't0', b: 't0' }, spills: 0 });
          });

          it('uses separate registers for overlapping intervals', () => {
            const result = allocateLinearScan([
              { value: 'a', start: 0, end: 3 },
              { value: 'b', start: 1, end: 2 },
            ], ['t0', 't1']);
            expect(result).toEqual({ locations: { a: 't0', b: 't1' }, spills: 0 });
          });

          it('spills the active interval ending farthest in the future', () => {
            const result = allocateLinearScan([
              { value: 'a', start: 0, end: 10 },
              { value: 'b', start: 1, end: 3 },
              { value: 'c', start: 2, end: 4 },
            ], ['t0', 't1']);
            expect(result).toEqual({ locations: { a: 'stack[0]', b: 't1', c: 't0' }, spills: 1 });
          });

          it('spills the current interval when it ends later than every active interval', () => {
            const result = allocateLinearScan([
              { value: 'a', start: 0, end: 3 },
              { value: 'b', start: 1, end: 4 },
              { value: 'c', start: 2, end: 10 },
            ], ['t0', 't1']);
            expect(result.locations.c).toBe('stack[0]');
            expect(result.spills).toBe(1);
          });

          it('is independent of input order and does not mutate input [gate:spills]', () => {
            const intervals = [
              { value: 'c', start: 2, end: 4 },
              { value: 'a', start: 0, end: 10 },
              { value: 'b', start: 1, end: 3 },
            ];
            const snapshot = JSON.stringify(intervals);
            const result = allocateLinearScan(intervals, ['t0', 't1']);
            count('registerSpills', result.spills);
            expect(result.locations).toEqual({ a: 'stack[0]', b: 't1', c: 't0' });
            expect(JSON.stringify(intervals)).toBe(snapshot);
          });

          it('rejects duplicates and invalid intervals', () => {
            expect(errorOf(() => allocateLinearScan([
              { value: 'a', start: 0, end: 1 }, { value: 'a', start: 2, end: 3 },
            ], ['t0']))).toBe('duplicate value a');
            expect(errorOf(() => allocateLinearScan([{ value: 'a', start: 3, end: 2 }], ['t0']))).toBe('invalid interval a');
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.registerSpills',
      op: 'lte',
      value: 1,
      unit: 'slots',
      zh: '三个区间使用两个寄存器时最多 spill 一个 value',
      en: 'Three intervals using two registers should spill at most one value',
      dimension: 'latency',
      scope: 'gate:spills',
    }),
  ],
  referenceFiles: [
    file(
      'src/registers.ts',
      code`
        export interface LiveInterval { value: string; start: number; end: number }
        export interface Allocation {
          locations: Record<string, string>;
          spills: number;
        }

        interface ActiveEntry { interval: LiveInterval; register: string }

        export function allocateLinearScan(intervals: LiveInterval[], registers: string[]): Allocation {
          if (registers.length === 0 || new Set(registers).size !== registers.length) throw new Error('invalid registers');
          const seen = new Set<string>();
          for (const interval of intervals) {
            if (seen.has(interval.value)) throw new Error('duplicate value ' + interval.value);
            seen.add(interval.value);
            if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.start > interval.end) {
              throw new Error('invalid interval ' + interval.value);
            }
          }
          const ordered = intervals.map((interval) => ({ ...interval })).sort((left, right) =>
            left.start - right.start || left.end - right.end || left.value.localeCompare(right.value)
          );
          const registerOrder = new Map(registers.map((register, index) => [register, index]));
          const free = registers.slice();
          const active: ActiveEntry[] = [];
          const locations: Record<string, string> = {};
          let spills = 0;

          function sortActive(): void {
            active.sort((left, right) => left.interval.end - right.interval.end || left.interval.value.localeCompare(right.interval.value));
          }

          function expire(start: number): void {
            for (let index = active.length - 1; index >= 0; index -= 1) {
              if (active[index].interval.end < start) {
                free.push(active[index].register);
                active.splice(index, 1);
              }
            }
            free.sort((left, right) => (registerOrder.get(left) as number) - (registerOrder.get(right) as number));
          }

          function spillLocation(): string {
            const location = 'stack[' + spills + ']';
            spills += 1;
            return location;
          }

          for (const interval of ordered) {
            expire(interval.start);
            if (free.length) {
              const register = free.shift() as string;
              locations[interval.value] = register;
              active.push({ interval, register });
              sortActive();
              continue;
            }
            sortActive();
            const farthest = active[active.length - 1];
            if (farthest.interval.end > interval.end) {
              locations[farthest.interval.value] = spillLocation();
              locations[interval.value] = farthest.register;
              active[active.length - 1] = { interval, register: farthest.register };
              sortActive();
            } else {
              locations[interval.value] = spillLocation();
            }
          }

          return { locations, spills };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · Code generation                                          */
/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'rv64-codegen',
  title: t('第 9 关 · RV64 指令选择与调用约定', 'Stage 9 · RV64 instruction selection and calling convention'),
  goal: t(
    [
      '后端要把目标无关 IR 变成满足 ABI 的机器指令。寄存器值可以直接参与运算，spill 值必须先 load；发生 call 时还要保存返回地址并把参数放进 a0 到 a7。',
      '',
      '在 `src/codegen.ts` 实现 `emitRv64(functionIr, locations)`：',
      '',
      '- 支持 const、add、sub、mul、call 和 return；',
      '- `stack[n]` 使用 8 字节 slot，栈帧按 16 字节对齐；',
      '- t4、t5、t6 作为后端保留的 scratch 寄存器；',
      '- call 参数依次放入 a0 到 a7，超过 8 个时报错；',
      '- 含 call 的函数保存并恢复 ra；',
      '- 返回值最终放进 a0。',
      '',
      '栈帧大小不能只看 spill 数量。叶子函数可以没有 ra slot，非叶子函数即使没有 spill 也必须保存返回地址。',
    ].join('\n'),
    [
      'The backend turns target-independent IR into instructions that satisfy an ABI. Register values can',
      'feed operations directly, spilled values need loads, and calls require saving the return address and',
      'placing arguments in a0 through a7.',
      '',
      'Implement `emitRv64(functionIr, locations)` in `src/codegen.ts`:',
      '',
      '- Support const, add, sub, mul, call and return;',
      '- Give each `stack[n]` an eight-byte slot and align frames to 16 bytes;',
      '- Reserve t4, t5 and t6 as backend scratch registers;',
      '- Put call arguments in a0 through a7 and reject more than eight;',
      '- Save and restore ra in a function containing a call;',
      '- Place the return value in a0.',
      '',
      'Frame size cannot depend on spills alone. A leaf may need no ra slot, while a non-leaf must preserve',
      'the return address even when nothing spills.',
    ].join('\n')
  ),
  checklist: [
    t('spill value 在使用前 load，在定义后 store', 'Spilled values load before use and store after definition'),
    t('栈帧保持 16 字节对齐', 'Stack frames stay 16-byte aligned'),
    t('call 参数遵守 a0 到 a7 约定', 'Call arguments use a0 through a7'),
    t('非叶子函数保存并恢复 ra', 'Non-leaf functions save and restore ra'),
  ],
  hints: [
    t('先扫描 locations 求最大 stack slot，再扫描 IR 判断是否有 call。', 'Scan locations for the largest stack slot and IR for calls before emitting the prologue.'),
    t('封装 read(value, scratch) 和 write(id, register)，统一处理 spill。', 'Use read(value, scratch) and write(id, register) helpers for spills.'),
  ],
  pitfalls: [
    t('call 前不保存 ra 会让非叶子函数的 ret 跳回错误地址。', 'Failing to save ra before a call makes a non-leaf return to the wrong address.'),
    t('直接对 stack location 发出 add 指令会生成目标机器不存在的内存到内存算术。', 'Emitting add directly on stack locations creates memory-to-memory arithmetic the target does not have.'),
  ],
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/codegen.ts',
      code`
        export type Value = string | number;
        export interface MachineIrInstruction {
          id: string;
          op: 'const' | 'add' | 'sub' | 'mul' | 'call';
          args: Value[];
        }
        export interface MachineFunction { name: string; instructions: MachineIrInstruction[]; returnValue: Value }

        export function emitRv64(input: MachineFunction, locations: Record<string, string>): string[] {
          // TODO: emit a frame, materialise spills, follow the call ABI and return through a0
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-9.spec.ts',
      code`
        import { emitRv64 } from '../src/codegen';

        describe('Stage 9 · RV64 code generation', () => {
          it('emits a leaf function without an unnecessary frame', () => {
            const assembly = emitRv64({
              name: 'sum',
              instructions: [
                { id: '%0', op: 'const', args: [2] },
                { id: '%1', op: 'const', args: [3] },
                { id: '%2', op: 'add', args: ['%0', '%1'] },
              ],
              returnValue: '%2',
            }, { '%0': 't0', '%1': 't1', '%2': 't2' });
            expect(assembly).toEqual([
              'sum:', 'li t0, 2', 'li t1, 3', 'add t2, t0, t1', 'mv a0, t2', 'ret',
            ]);
          });

          it('materialises a spilled definition and use through the stack', () => {
            const assembly = emitRv64({
              name: 'spilled',
              instructions: [{ id: '%0', op: 'const', args: [7] }],
              returnValue: '%0',
            }, { '%0': 'stack[0]' });
            expect(assembly).toEqual([
              'spilled:',
              'addi sp, sp, -16',
              'li t4, 7',
              'sd t4, 0(sp)',
              'ld t6, 0(sp)',
              'mv a0, t6',
              'addi sp, sp, 16',
              'ret',
            ]);
          });

          it('passes call arguments and preserves ra', () => {
            const assembly = emitRv64({
              name: 'caller',
              instructions: [
                { id: '%0', op: 'const', args: [5] },
                { id: '%1', op: 'call', args: ['double', '%0'] },
              ],
              returnValue: '%1',
            }, { '%0': 't0', '%1': 't1' });
            expect(assembly).toEqual([
              'caller:',
              'addi sp, sp, -16',
              'sd ra, 8(sp)',
              'li t0, 5',
              'mv a0, t0',
              'call double',
              'mv t1, a0',
              'mv a0, t1',
              'ld ra, 8(sp)',
              'addi sp, sp, 16',
              'ret',
            ]);
          });

          it('loads spilled arithmetic operands into scratch registers', () => {
            const assembly = emitRv64({
              name: 'math',
              instructions: [{ id: '%2', op: 'mul', args: ['%0', '%1'] }],
              returnValue: '%2',
            }, { '%0': 'stack[0]', '%1': 'stack[1]', '%2': 't0' });
            expect(assembly.includes('ld t5, 0(sp)')).toBe(true);
            expect(assembly.includes('ld t6, 8(sp)')).toBe(true);
            expect(assembly.includes('mul t0, t5, t6')).toBe(true);
          });

          it('rejects calls with more than eight register arguments', () => {
            let message = '';
            try {
              emitRv64({
                name: 'bad',
                instructions: [{ id: '%0', op: 'call', args: ['f', 1, 2, 3, 4, 5, 6, 7, 8, 9] }],
                returnValue: '%0',
              }, { '%0': 't0' });
            } catch (error) { message = (error as Error).message; }
            expect(message).toBe('too many call arguments');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/codegen.ts',
      code`
        export type Value = string | number;
        export interface MachineIrInstruction {
          id: string;
          op: 'const' | 'add' | 'sub' | 'mul' | 'call';
          args: Value[];
        }
        export interface MachineFunction { name: string; instructions: MachineIrInstruction[]; returnValue: Value }

        export function emitRv64(input: MachineFunction, locations: Record<string, string>): string[] {
          const lines: string[] = [input.name + ':'];
          const stackSlots = Object.values(locations)
            .filter((location) => location.startsWith('stack[') && location.endsWith(']'))
            .map((location) => Number(location.slice(6, -1)) + 1);
          const slots = stackSlots.length ? Math.max(...stackSlots) : 0;
          const hasCall = input.instructions.some((instruction) => instruction.op === 'call');
          const rawFrame = slots * 8 + (hasCall ? 8 : 0);
          const frameSize = rawFrame === 0 ? 0 : Math.ceil(rawFrame / 16) * 16;

          function stackOffset(location: string): number {
            return Number(location.slice(6, -1)) * 8;
          }

          function locationOf(value: string): string {
            const location = locations[value];
            if (!location) throw new Error('missing location for ' + value);
            return location;
          }

          function read(value: Value, scratch: string): string {
            if (typeof value === 'number') {
              lines.push('li ' + scratch + ', ' + value);
              return scratch;
            }
            const location = locationOf(value);
            if (location.startsWith('stack[')) {
              lines.push('ld ' + scratch + ', ' + stackOffset(location) + '(sp)');
              return scratch;
            }
            return location;
          }

          function write(id: string, source: string): void {
            const location = locationOf(id);
            if (location.startsWith('stack[')) lines.push('sd ' + source + ', ' + stackOffset(location) + '(sp)');
            else if (location !== source) lines.push('mv ' + location + ', ' + source);
          }

          if (frameSize) lines.push('addi sp, sp, -' + frameSize);
          if (hasCall) lines.push('sd ra, ' + (frameSize - 8) + '(sp)');

          for (const instruction of input.instructions) {
            if (instruction.op === 'const') {
              const location = locationOf(instruction.id);
              if (location.startsWith('stack[')) {
                lines.push('li t4, ' + instruction.args[0]);
                write(instruction.id, 't4');
              } else {
                lines.push('li ' + location + ', ' + instruction.args[0]);
              }
              continue;
            }
            if (instruction.op === 'call') {
              const callee = String(instruction.args[0]);
              const args = instruction.args.slice(1);
              if (args.length > 8) throw new Error('too many call arguments');
              args.forEach((argument, index) => {
                const source = read(argument, index % 2 === 0 ? 't5' : 't6');
                if (source !== 'a' + index) lines.push('mv a' + index + ', ' + source);
              });
              lines.push('call ' + callee);
              write(instruction.id, 'a0');
              continue;
            }
            const left = read(instruction.args[0], 't5');
            const right = read(instruction.args[1], 't6');
            const location = locationOf(instruction.id);
            const destination = location.startsWith('stack[') ? 't4' : location;
            lines.push(instruction.op + ' ' + destination + ', ' + left + ', ' + right);
            write(instruction.id, destination);
          }

          const returned = read(input.returnValue, 't6');
          if (returned !== 'a0') lines.push('mv a0, ' + returned);
          if (hasCall) lines.push('ld ra, ' + (frameSize - 8) + '(sp)');
          if (frameSize) lines.push('addi sp, sp, ' + frameSize);
          lines.push('ret');
          return lines;
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · Incremental build                                       */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'incremental-build',
  title: t('第 10 关 · 模块图与增量构建缓存', 'Stage 10 · Module graphs and incremental build caches'),
  goal: t(
    [
      '完整编译器不仅要把一个文件编对，还要在大型工程里只重编真正失效的模块。缓存键必须包含源码和依赖输出，构建失败时也不能提交半套新缓存。',
      '',
      '在 `src/incremental.ts` 实现 `createIncrementalCompiler(compile)`：',
      '',
      '- 构建前验证缺失依赖和循环依赖；',
      '- 按拓扑顺序编译模块；',
      '- 缓存指纹包含模块源码和依赖输出；',
      '- 未变化模块命中缓存，变化模块的依赖者按输出是否变化决定是否重编；',
      '- 删除已经不在本轮输入中的缓存项；',
      '- 任一模块失败时，整轮缓存更新不提交。',
      '',
      '依赖源码变化不一定要求上层重编。如果依赖重新编译后的公开输出没有变化，上层指纹仍然相同，可以继续命中缓存。',
    ].join('\n'),
    [
      'A complete compiler must do more than compile one file correctly. In a large project it should rebuild',
      'only invalidated modules. Cache keys include source and dependency outputs, and a failed build must not',
      'commit half of a new cache.',
      '',
      'Implement `createIncrementalCompiler(compile)` in `src/incremental.ts`:',
      '',
      '- Validate missing and cyclic dependencies before compilation;',
      '- Compile modules in topological order;',
      '- Include module source and dependency outputs in each fingerprint;',
      '- Hit unchanged modules and rebuild dependants only when dependency output changes;',
      '- Remove cache entries absent from the current input;',
      '- Commit no cache update when any module fails.',
      '',
      'A dependency source change does not always invalidate its users. If recompilation produces the same',
      'public output, dependant fingerprints remain unchanged and can still hit cache.',
    ].join('\n')
  ),
  checklist: [
    t('模块按依赖拓扑顺序编译', 'Modules compile in dependency order'),
    t('缓存指纹包含依赖输出', 'Cache fingerprints include dependency outputs'),
    t('公开输出未变化时不扩散重编', 'Unchanged public output stops recompilation from spreading'),
    t('失败构建不会污染已提交缓存', 'A failed build does not pollute committed cache'),
  ],
  hints: [
    t('先用 DFS 生成完整拓扑序，再开始调用 compile。', 'Build a complete topological order with DFS before calling compile.'),
    t('在 cache 副本上写入，所有模块成功后再替换正式 cache。', 'Write into a cache copy and replace the committed cache only after every module succeeds.'),
  ],
  pitfalls: [
    t('只用本文件源码做 cache key，会在依赖输出变化后错误复用旧产物。', 'Using only local source as the cache key reuses stale output after a dependency changes.'),
    t('边拓扑遍历边提交缓存，后续模块失败时会留下半轮新状态。', 'Committing cache entries during traversal leaves half a new build behind when a later module fails.'),
  ],
  focus: ['correctness', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/incremental.ts',
      code`
        export interface SourceModule { id: string; source: string; dependencies: string[] }
        export interface BuildResult {
          outputs: Record<string, string>;
          compiled: string[];
          cacheHits: number;
        }
        export type CompileModule = (module: SourceModule, dependencyOutputs: string[]) => string;
        export interface IncrementalCompiler { build(modules: SourceModule[]): BuildResult }

        export function createIncrementalCompiler(compile: CompileModule): IncrementalCompiler {
          // TODO: validate the graph, fingerprint transitive inputs and commit cache atomically
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-10.spec.ts',
      code`
        import { createIncrementalCompiler, type SourceModule } from '../src/incremental';
        import { count } from '@lab/metrics';

        const sourceModule = (id: string, source: string, dependencies: string[] = []): SourceModule => ({ id, source, dependencies });

        describe('Stage 10 · Incremental compilation', () => {
          it('compiles dependencies before their users', () => {
            const order: string[] = [];
            const compiler = createIncrementalCompiler((item, dependencies) => {
              order.push(item.id);
              return item.source + '(' + dependencies.join(',') + ')';
            });
            const result = compiler.build([sourceModule('app', 'A', ['core']), sourceModule('core', 'C')]);
            expect(order).toEqual(['core', 'app']);
            expect(result.compiled).toEqual(['core', 'app']);
            expect(result.outputs.app).toBe('A(C())');
          });

          it('hits every module on an unchanged second build [gate:compiled]', () => {
            const compiler = createIncrementalCompiler((item, dependencies) => item.source + dependencies.join(''));
            const modules = [sourceModule('core', 'C'), sourceModule('app', 'A', ['core'])];
            compiler.build(modules);
            const second = compiler.build(modules);
            count('incrementalCompiled', second.compiled.length);
            expect(second.compiled).toEqual([]);
            expect(second.cacheHits).toBe(2);
          });

          it('rebuilds a changed dependency and affected users only', () => {
            const compiler = createIncrementalCompiler((item, dependencies) => item.source + dependencies.join(''));
            compiler.build([sourceModule('core', 'C1'), sourceModule('app', 'A', ['core']), sourceModule('docs', 'D')]);
            const result = compiler.build([sourceModule('core', 'C2'), sourceModule('app', 'A', ['core']), sourceModule('docs', 'D')]);
            expect(result.compiled).toEqual(['core', 'app']);
            expect(result.cacheHits).toBe(1);
          });

          it('stops invalidation when a dependency public output is unchanged', () => {
            const compiler = createIncrementalCompiler((item, dependencies) => item.source.split(':')[0] + dependencies.join(''));
            compiler.build([sourceModule('core', 'API:impl1'), sourceModule('app', 'APP:', ['core'])]);
            const result = compiler.build([sourceModule('core', 'API:impl2'), sourceModule('app', 'APP:', ['core'])]);
            expect(result.compiled).toEqual(['core']);
            expect(result.cacheHits).toBe(1);
          });

          it('detects a cycle before compiling anything', () => {
            const compiled: string[] = [];
            const compiler = createIncrementalCompiler((item) => { compiled.push(item.id); return item.source; });
            let message = '';
            try { compiler.build([sourceModule('a', 'A', ['b']), sourceModule('b', 'B', ['a'])]); }
            catch (error) { message = (error as Error).message; }
            expect(message).toBe('dependency cycle at a');
            expect(compiled).toEqual([]);
          });

          it('does not commit a partial cache after compilation fails', () => {
            let fail = true;
            const calls: string[] = [];
            const compiler = createIncrementalCompiler((item) => {
              calls.push(item.id);
              if (item.id === 'bad' && fail) throw new Error('compile failed');
              return item.source;
            });
            try { compiler.build([sourceModule('a', 'A'), sourceModule('bad', 'B', ['a'])]); } catch (error) {}
            fail = false;
            calls.length = 0;
            const result = compiler.build([sourceModule('a', 'A'), sourceModule('bad', 'B', ['a'])]);
            expect(calls).toEqual(['a', 'bad']);
            expect(result.compiled).toEqual(['a', 'bad']);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.incrementalCompiled',
      op: 'eq',
      value: 0,
      unit: 'modules',
      zh: '输入未变化时第二次构建不能重新编译模块',
      en: 'An unchanged second build must compile zero modules',
      dimension: 'latency',
      scope: 'gate:compiled',
    }),
  ],
  referenceFiles: [
    file(
      'src/incremental.ts',
      code`
        export interface SourceModule { id: string; source: string; dependencies: string[] }
        export interface BuildResult {
          outputs: Record<string, string>;
          compiled: string[];
          cacheHits: number;
        }
        export type CompileModule = (module: SourceModule, dependencyOutputs: string[]) => string;
        export interface IncrementalCompiler { build(modules: SourceModule[]): BuildResult }

        interface CacheEntry { fingerprint: string; output: string }

        export function createIncrementalCompiler(compile: CompileModule): IncrementalCompiler {
          let cache = new Map<string, CacheEntry>();

          return {
            build(modules): BuildResult {
              const byId = new Map<string, SourceModule>();
              for (const item of modules) {
                if (byId.has(item.id)) throw new Error('duplicate module ' + item.id);
                byId.set(item.id, item);
              }
              for (const item of modules) {
                for (const dependency of item.dependencies) {
                  if (!byId.has(dependency)) throw new Error('missing dependency ' + dependency);
                }
              }

              const state = new Map<string, 'visiting' | 'done'>();
              const order: string[] = [];
              function visit(id: string): void {
                if (state.get(id) === 'visiting') throw new Error('dependency cycle at ' + id);
                if (state.get(id) === 'done') return;
                state.set(id, 'visiting');
                (byId.get(id) as SourceModule).dependencies.forEach(visit);
                state.set(id, 'done');
                order.push(id);
              }
              modules.forEach((item) => visit(item.id));

              const draft = new Map(cache);
              const outputs: Record<string, string> = {};
              const compiled: string[] = [];
              let cacheHits = 0;
              for (const id of order) {
                const item = byId.get(id) as SourceModule;
                const dependencyOutputs = item.dependencies.map((dependency) => outputs[dependency]);
                const fingerprint = JSON.stringify([item.source, dependencyOutputs]);
                const existing = cache.get(id);
                if (existing && existing.fingerprint === fingerprint) {
                  outputs[id] = existing.output;
                  cacheHits += 1;
                } else {
                  const output = compile(item, dependencyOutputs);
                  outputs[id] = output;
                  draft.set(id, { fingerprint, output });
                  compiled.push(id);
                }
              }
              for (const id of Array.from(draft.keys())) {
                if (!byId.has(id)) draft.delete(id);
              }
              cache = draft;
              return { outputs, compiled, cacheHits };
            },
          };
        }
      `
    ),
  ],
};

module.exports = {
  id: 'modern-compiler',
  title: t('从 0 写一个现代编译系统', 'Build a modern compiler from scratch'),
  summary: t(
    '从带源码位置的 Lexer 开始，完成 Pratt 解析、名字解析、类型合一和 SSA。后半程继续做支配分析、优化、寄存器分配、RV64 代码生成与增量构建。共十关。',
    'Start with a source-aware lexer, then build Pratt parsing, name resolution, type unification and SSA. Dominance, optimisation, register allocation, RV64 code generation and incremental builds complete the ten stages.'
  ),
  difficulty: 'Hard',
  domain: 'compilers',
  tags: ['compiler', 'parser', 'type-system', 'ssa', 'optimization', 'register-allocation', 'codegen', 'incremental'],
  estimatedMinutes: 480,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 0.5,
    latency: 2,
    resilience: 1.5,
    encapsulation: 2,
    elegance: 2,
  },
  brief: t(
    [
      '## 最后会得到什么',
      '',
      '你会把一段小型表达式语言编译成可读的 RV64 汇编。输入先经过词法分析和 Pratt 解析，',
      '再完成名字解析与类型推断；后端把 AST 降成 SSA，分析控制流，做优化和寄存器分配，',
      '最后生成符合调用约定的指令。第 10 关把这些步骤接入模块图和增量构建缓存。',
      '',
      '项目不把编译器当成一个从字符串直接吐出汇编的函数。每一关都要交付明确的中间产物，',
      '下一关会直接读取它。token 的源码位置会进入 AST，binding id 会进入类型检查，',
      'SSA 的基本块和 phi 节点会继续流向支配分析、优化与代码生成。',
      '',
      '## 十关的产物',
      '',
      '| 关卡 | 模块 | 产物 |',
      '| --- | --- | --- |',
      '| 1 | Lexer | 带源码 span 的 token 流 |',
      '| 2 | Pratt Parser | 有优先级和完整 span 的表达式 AST |',
      '| 3 | 名字解析 | declaration 到 use 的 binding id |',
      '| 4 | 类型推断 | 约束、合一和 occurs check |',
      '| 5 | SSA lowering | 基本块、terminator 和 phi |',
      '| 6 | CFG 分析 | 前驱、支配集合和 immediate dominator |',
      '| 7 | 优化器 | 常量传播、折叠和 DCE |',
      '| 8 | 寄存器分配 | 线性扫描与 spill slot |',
      '| 9 | RV64 后端 | 指令选择、栈帧和调用约定 |',
      '| 10 | 增量构建 | 模块图、缓存指纹和失效传播 |',
      '',
      '## 你需要处理的难点',
      '',
      '前端的错误不能停在「解析失败」。词法和语法节点要保留 span，名字解析要区分作用域和遮蔽，',
      '类型合一还要拒绝无限类型。进入 SSA 后，你需要维护 CFG 前驱、支配关系和 phi 输入，',
      '否则常量传播与死代码删除会在分支处悄悄改错程序。',
      '',
      '寄存器不足时，线性扫描分配器会把值 spill 到栈上。代码生成既要选对 RV64 指令，',
      '也要保持栈帧和调用约定。增量构建则要区分成功缓存与失败缓存，并把依赖失效传到正确的模块。',
      '',
      '## 怎么验收',
      '',
      '每关既检查正常输入，也检查中间表示是否自洽。尾部 token、无限类型、不可达块、',
      '错误 spill、ABI 栈对齐和失败缓存都会单独测试。部分关卡还会限制重复遍历或无效重编译，',
      '所以输出正确但数据结构混乱的实现也可能过不了。',
      '',
      '## 项目边界',
      '',
      '前端使用项目内定义的小型语言，后端只输出 RV64 汇编文本。项目不依赖 LLVM，',
      '也不把词法、语法、类型或寄存器分配交给第三方库。它不会链接并运行完整的原生程序，',
      '重点是让每一层的算法和数据结构可以单独检查。',
    ].join('\n'),
    [
      '## What you will have at the end',
      '',
      'You will compile a small expression language into readable RV64 assembly. The input passes',
      'through lexing and Pratt parsing, then name resolution and type inference. The backend lowers',
      'the AST into SSA, analyses control flow, optimises it, allocates registers, and emits instructions',
      'that follow the calling convention. Stage 10 connects the pipeline to a module graph and an',
      'incremental build cache.',
      '',
      'The compiler is not treated as one function from a string to assembly. Every stage produces an',
      'explicit intermediate result that the next stage consumes. Token spans enter the AST, binding ids',
      'enter type checking, and SSA blocks and phi nodes continue through dominance, optimisation, and',
      'code generation.',
      '',
      '## Outputs from the ten stages',
      '',
      '| Stage | Module | Output |',
      '| --- | --- | --- |',
      '| 1 | Lexer | Token stream with source spans |',
      '| 2 | Pratt parser | Precedence-aware expression AST with complete spans |',
      '| 3 | Name resolution | Binding ids from declarations to uses |',
      '| 4 | Type inference | Constraints, unification and occurs checks |',
      '| 5 | SSA lowering | Basic blocks, terminators and phi nodes |',
      '| 6 | CFG analysis | Predecessors, dominator sets and immediate dominators |',
      '| 7 | Optimiser | Constant propagation, folding and DCE |',
      '| 8 | Register allocation | Linear scan and spill slots |',
      '| 9 | RV64 backend | Instruction selection, stack frames and calling convention |',
      '| 10 | Incremental build | Module graph, cache fingerprints and invalidation |',
      '',
      '## Problems you must handle',
      '',
      'Frontend errors need more information than "parse failed". Tokens and syntax nodes keep source',
      'spans, name resolution distinguishes scopes and shadowing, and unification must reject infinite',
      'types. Once the program reaches SSA, you must keep CFG predecessors, dominance, and phi inputs',
      'consistent or constant propagation and dead-code elimination will change programs at branches.',
      '',
      'When registers run out, the linear-scan allocator spills values to the stack. Code generation must',
      'choose the right RV64 instructions while preserving stack frames and the calling convention.',
      'Incremental builds must distinguish successful and failed cache entries and propagate invalidation',
      'to the correct dependent modules.',
      '',
      '## How it is checked',
      '',
      'Each stage checks ordinary input and the consistency of its intermediate representation. Trailing',
      'tokens, infinite types, unreachable blocks, bad spills, ABI stack alignment, and failed cache',
      'transactions are tested separately. Some stages also limit repeated traversal or unnecessary',
      'recompilation, so correct final output is not enough if the internal representation is unsound.',
      '',
      '## Project boundary',
      '',
      'The frontend uses the small language defined by the project and the backend emits RV64 assembly',
      'text. The project does not depend on LLVM or delegate lexing, parsing, typing, or register',
      'allocation to third-party libraries. It does not link and execute a complete native program.',
      'The focus is on making each algorithm and data structure independently testable.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart LR',
      '  S[源码] --> L[Lexer]',
      '  L --> P[Pratt Parser]',
      '  P --> R[名字解析]',
      '  R --> T[类型推断]',
      '  T --> I[SSA IR]',
      '  I --> C[CFG 与支配分析]',
      '  C --> O[优化器]',
      '  O --> A[寄存器分配]',
      '  A --> G[RV64 代码生成]',
      '  M[模块图与缓存] --> L',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart LR',
      '  S[source] --> L[lexer]',
      '  L --> P[Pratt parser]',
      '  P --> R[name resolution]',
      '  R --> T[type inference]',
      '  T --> I[SSA IR]',
      '  I --> C[CFG and dominance]',
      '  C --> O[optimiser]',
      '  O --> A[register allocation]',
      '  A --> G[RV64 code generation]',
      '  M[module graph and cache] --> L',
      '```',
    ].join('\n')
  ),
  files: [],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10],
};
