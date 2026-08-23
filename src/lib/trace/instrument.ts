/**
 * 给 JS / TS 源码插桩，让它一边跑一边把每步状态报给记录器。
 *
 * 用 TypeScript 编译器的 transformer 而不是正则或者文本拼接：
 * 箭头函数的简写体、getter、类方法、可选链这些形态，文本方案迟早会踩空。
 * 行号在变换时就从原始节点上取好、写成字面量嵌进去，所以后面 printer
 * 怎么重排格式都不影响行号的准确性。
 *
 * 插入的调用：
 *   __trace.enter(fnName)      函数进入
 *   __trace.exit()             函数退出（放在 finally 里，抛异常也会走到）
 *   __trace.step(line, {vars}) 每条语句执行前
 */

type TsModule = typeof import('typescript');
type AnyNode = any;

export interface InstrumentOptions {
  /** 注入的记录器在代码里的变量名 */
  recorderName?: string;
}

/** 收集一个函数作用域里「到这一句为止已经声明」的变量名 */
function collectBindingNames(ts: TsModule, name: AnyNode, out: string[]): void {
  if (!name) return;
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  // 解构：const [a, b] = xs / const {x, y} = obj
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBindingNames(ts, element.name, out);
    }
  }
}

function functionDisplayName(ts: TsModule, node: AnyNode): string {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  // const f = () => {} / const f = function () {}
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (node.kind === ts.SyntaxKind.ArrowFunction) return '(arrow)';
  return '(anonymous)';
}

export function instrumentSource(
  ts: TsModule,
  code: string,
  options: InstrumentOptions = {}
): string {
  const recorder = options.recorderName || '__trace';

  const source = ts.createSourceFile(
    'user.ts',
    code,
    ts.ScriptTarget.ES2020,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const lineOf = (node: AnyNode): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const transformer = (context: AnyNode) => {
    const factory = context.factory;

    /**
     * 作用域栈。必须按「块」而不是按「函数」记，否则会生成引用已经离开作用域
     * 的变量的代码 —— 比如在 for 之后的语句里去读循环里的 const，直接 ReferenceError。
     */
    interface Scope {
      names: string[];
      /** 是不是函数边界：往上找可见变量时到这一层为止 */
      fnBoundary: boolean;
    }
    const scopes: Scope[] = [{ names: [], fnBoundary: true }];
    const pushScope = (fnBoundary = false) => scopes.push({ names: [], fnBoundary });
    const popScope = () => scopes.pop();
    const declare = (name: string) => {
      const top = scopes[scopes.length - 1];
      if (name && !top.names.includes(name)) top.names.push(name);
    };
    /**
     * 当前位置可见的名字：从栈顶往下收集，遇到函数边界就停。
     * 不跨函数是刻意的 —— 闭包捕获的外层变量每步都快照一遍太贵，
     * 而且做题时关心的基本都是本函数内的状态。
     */
    const visibleNames = (): string[] => {
      const out: string[] = [];
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        for (const name of scopes[i].names) {
          if (!out.includes(name)) out.push(name);
        }
        if (scopes[i].fnBoundary) break;
      }
      return out.reverse();
    };

    const makeStepCall = (line: number): AnyNode => {
      const names = visibleNames();
      const props = names.map((name) =>
        factory.createPropertyAssignment(
          factory.createStringLiteral(name),
          factory.createIdentifier(name)
        )
      );
      return factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier(recorder),
            'step'
          ),
          undefined,
          [factory.createNumericLiteral(line), factory.createObjectLiteralExpression(props, false)]
        )
      );
    };

    const makeEnterCall = (name: string): AnyNode =>
      factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier(recorder), 'enter'),
          undefined,
          [factory.createStringLiteral(name)]
        )
      );

    const makeExitCall = (): AnyNode =>
      factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier(recorder), 'exit'),
          undefined,
          []
        )
      );

    /** 在语句列表里逐条插入 step 调用 */
    const instrumentStatements = (statements: AnyNode[], visitor: AnyNode): AnyNode[] => {
      const out: AnyNode[] = [];
      for (const statement of statements) {
        // 函数声明本身不是「执行的一步」，提前声明名字即可
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          declare(statement.name.text);
          out.push(ts.visitNode(statement, visitor));
          continue;
        }

        const line = lineOf(statement);
        // 先记录，再执行：这一步显示的是「执行这行之前」的状态
        out.push(makeStepCall(line));
        const visited = ts.visitNode(statement, visitor);

        // 声明语句要在访问之后登记，这样同一行的 step 不会引用尚未初始化的名字
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            const names: string[] = [];
            collectBindingNames(ts, decl.name, names);
            names.forEach(declare);
          }
        }
        out.push(visited);
      }
      return out;
    };

    /**
     * 不带大括号的单语句体（`for (...) total += i;`、`if (x) return y;`）
     * 先补成块，否则它永远不会被插桩 —— 一个两万次的循环只能录到 4 步。
     * 补大括号不改变语义，因为里面本来就只有一条语句。
     */
    const asBlock = (statement: AnyNode): AnyNode =>
      statement && !ts.isBlock(statement) ? factory.createBlock([statement], true) : statement;

    const normalizeBodies = (node: AnyNode): AnyNode => {
      if (ts.isIfStatement(node)) {
        const thenPart = asBlock(node.thenStatement);
        // else if 保持链式，不要把它包成块，否则会多出一层缩进
        const elsePart =
          node.elseStatement && !ts.isIfStatement(node.elseStatement)
            ? asBlock(node.elseStatement)
            : node.elseStatement;
        if (thenPart !== node.thenStatement || elsePart !== node.elseStatement) {
          return factory.updateIfStatement(node, node.expression, thenPart, elsePart);
        }
        return node;
      }
      if (ts.isForStatement(node) && !ts.isBlock(node.statement)) {
        return factory.updateForStatement(
          node, node.initializer, node.condition, node.incrementor, asBlock(node.statement)
        );
      }
      if (ts.isForOfStatement(node) && !ts.isBlock(node.statement)) {
        return factory.updateForOfStatement(
          node, node.awaitModifier, node.initializer, node.expression, asBlock(node.statement)
        );
      }
      if (ts.isForInStatement(node) && !ts.isBlock(node.statement)) {
        return factory.updateForInStatement(
          node, node.initializer, node.expression, asBlock(node.statement)
        );
      }
      if (ts.isWhileStatement(node) && !ts.isBlock(node.statement)) {
        return factory.updateWhileStatement(node, node.expression, asBlock(node.statement));
      }
      if (ts.isDoStatement(node) && !ts.isBlock(node.statement)) {
        return factory.updateDoStatement(node, asBlock(node.statement), node.expression);
      }
      return node;
    };

    const visitor = (rawNode: AnyNode): AnyNode => {
      const node = normalizeBodies(rawNode);

      // ---- 函数：压一层作用域，body 包 try/finally ----
      const isFunctionLike =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node);

      if (isFunctionLike) {
        const displayName = functionDisplayName(ts, node);
        pushScope(true);
        // 参数在函数体里立刻可见
        for (const param of node.parameters) {
          const names: string[] = [];
          collectBindingNames(ts, param.name, names);
          names.forEach(declare);
        }

        let newBody: AnyNode;
        if (node.body && ts.isBlock(node.body)) {
          const inner = instrumentStatements(node.body.statements as unknown as AnyNode[], visitor);
          newBody = factory.createBlock(
            [
              makeEnterCall(displayName),
              factory.createTryStatement(
                factory.createBlock(inner, true),
                undefined,
                factory.createBlock([makeExitCall()], true)
              ),
            ],
            true
          );
        } else if (node.body) {
          // 箭头函数简写体：x => expr。先展开成块再插桩，
          // 否则 return 的位置没法记录。
          const expr = ts.visitNode(node.body, visitor);
          newBody = factory.createBlock(
            [
              makeEnterCall(displayName),
              factory.createTryStatement(
                factory.createBlock(
                  [makeStepCall(lineOf(node.body)), factory.createReturnStatement(expr)],
                  true
                ),
                undefined,
                factory.createBlock([makeExitCall()], true)
              ),
            ],
            true
          );
        } else {
          newBody = node.body;
        }

        popScope();

        if (ts.isFunctionDeclaration(node)) {
          return factory.updateFunctionDeclaration(
            node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, newBody
          );
        }
        if (ts.isFunctionExpression(node)) {
          return factory.updateFunctionExpression(
            node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, newBody
          );
        }
        if (ts.isArrowFunction(node)) {
          return factory.updateArrowFunction(
            node, node.modifiers, node.typeParameters, node.parameters,
            node.type, node.equalsGreaterThanToken, newBody
          );
        }
        return factory.updateMethodDeclaration(
          node, node.modifiers, node.asteriskToken, node.name, node.questionToken,
          node.typeParameters, node.parameters, node.type, newBody
        );
      }

      // ---- 循环体 / if 分支等：确保是块，然后插桩 ----
      if (ts.isBlock(node)) {
        pushScope();
        const updated = factory.updateBlock(
          node,
          instrumentStatements(node.statements as unknown as AnyNode[], visitor)
        );
        popScope();
        return updated;
      }

      // 循环变量的作用域是「循环头 + 循环体」，出了循环就不可见，
      // 所以给循环单独开一层，访问完立刻弹掉。
      const isLoopWithBinding =
        (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer);

      if (isLoopWithBinding) {
        pushScope();
        for (const decl of node.initializer.declarations) {
          const names: string[] = [];
          collectBindingNames(ts, decl.name, names);
          names.forEach(declare);
        }
        const updated = ts.visitEachChild(node, visitor, context);
        popScope();
        return updated;
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return (root: AnyNode) => {
      const statements = instrumentStatements(root.statements as unknown as AnyNode[], visitor);
      return factory.updateSourceFile(root, statements);
    };
  };

  const result = ts.transform(source, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const output = printer.printFile(result.transformed[0]);
  result.dispose();

  // 插桩后还带着类型注解，交给 transpile 去掉
  return ts.transpileModule(output, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      strict: false,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}
